**Obsidian Relay: архитектура изменений мобильного приложения и план для GPT‑6.1 Sol High**

Дата исходного проекта: 2 октября 2026 года.
Основание: требования пользователя и read-only аудит текущего репозитория.

Обновление 3 октября 2026: основные этапы реализованы. Этот документ сохраняет исходные
архитектурные решения и исторический чеклист; актуальная матрица реализации, контракты,
проверки и действия владельца находятся в [completion-2026-10-03.ru.md](completion-2026-10-03.ru.md).
По последнему уточнению SMS, шлюз и проверка номера заменены журналом уведомлений PWA
и дополнительным Web Push. Фактический лимит вложения — 5 МБ; ограничения обработки
и эксплуатационные проверки описаны в итоговом отчёте.

**1. Зафиксированные решения и границы**

- Развиваем существующую React/Vite PWA, Fastify, TypeScript, SQLite и Git. Переписывание в native-приложение не входит в эту задачу.
- Две главные области: «ИИ-чат» и «Задачи». Настройки доступны из обеих.
- Пользователь подтвердил: **до пяти профилей ИИ для чата плюс один отдельный профиль сортировщика**. Сортировщик имеет собственные настройки API и ключ, не занимает слот чата.
- Чат имеет два режима: «Задача» и «Заметка». Ответы на вопросы по базе доступны в режиме заметки; отдельный третий режим не нужен.
- Результат запроса — созданная/изменённая заметка, задача или импортированный документ. Такие результаты сохраняются в vault и Git. Обычный ответ модели остаётся частью временной истории; сохранить его в заметку можно явно.
- История хранится по скользящему окну **14 × 24 часа от создания каждого сообщения**, а не 14 дней от последней активности чата. Продолжение разговора не продлевает срок старых сообщений.
- Расписание по умолчанию: среда и воскресенье, 23:59, **Europe/Moscow**. Часовой пояс редактируется отдельно от системного времени сервера.
- Допущение для SMS: воскресенье 23:50, до сортировки в 23:59. Время изменяется в настройках. Отправка включается после настройки SMS-шлюза и подтверждения номера.
- «Другая нейронка» означает другую каноническую модель относительно defaultChatProviderId рабочего пространства. Отдельный ключ к той же модели не считается другой нейронкой. Поставщик API может совпадать. При переключении базовой модели это ограничение проверяется снова; смена модели отдельного старого чата не меняет эту проверку.
- Кнопка ручного добавления **заметки** в области задач сохраняется как отдельное действие. Дополнительно нужна кнопка «Добавить задачу».
- Скриншот предоставлен позднее. По уточнению пользователя плюс внизу загружает файлы, жёлтая кнопка меняет режим ИИ. Левое меню открывает историю и новый чат; настройки доступны только внутри него. Новый вход открывает новый чат.
- Первый релиз — один владелец и один vault с несколькими доверенными устройствами. Ввести workspaceId в контракты, но не добавлять незапрошенную многопользовательскую систему.

Obsidian хранит заметки в Markdown-файлах vault. Поэтому интеграция работает с этими файлами и вложениями; отдельной «базы данных Obsidian», которую нужно заменять SQL-базой, здесь нет. [Документация Obsidian](https://obsidian.md/help/data-storage).

**2. Что уже есть и что нужно изменить**

| Участок | Текущее поведение | Изменение |
|---|---|---|
| packages/app/src/App.tsx | Экраны chat/settings | AppShell с двумя областями, список чатов, экраны задач |
| packages/app/src/screens/Chat.tsx | Один main-чат, общая slash-палитра, запись голоса | chatId, режимы, вложения, состояние уточнения, удаление голоса |
| packages/app/src/api.ts | REST/WS без полноценного возобновления операции | Общие DTO, requestId, последовательность событий, восстановление |
| packages/server/src/index.ts | Единственный агент/LLM, маршруты в одном файле | Разделение маршрутов и прикладных сервисов |
| packages/server/src/db.ts | messages привязаны к deviceId и строке chat; очистка 30 дней | Чаты владельца, migrations, TTL 14 дней, память и временные файлы |
| packages/server/src/config.ts | Один LLM из ENV, whisperModel | Импорт старого профиля, settings/providers, удаление Whisper |
| packages/server/src/sync.ts | Очередь только Git-операций, запись файлов вне неё | Общий VaultMutationService, версии, recovery, статусы публикации |
| packages/core/src/agent.ts | Общий prompt, последние 10 сообщений, прямые команды записи | Политика инструментов по режиму, context builder, draft state machine |
| packages/core/src/commands.ts | /quick пишет сразу, /idea направляет в Inbox | Единый реестр трёх команд режима заметки |
| packages/core/src/notes.ts | Задача — checkbox; теги необязательны | Типизированные задачи, обязательный срок, metadata enrichment |
| packages/core/src/tools.ts | Общее множество инструментов, обрезка прочитанного текста | Allowlist по режиму, строгие схемы, постраничное чтение |
| packages/core/src/vault.ts | Файловый адаптер и защита путей | Версии содержимого, rename/link integrity, единый путь мутаций |

Это результаты чтения кода, а не отчёт о запуске приложения. Сборка и тесты на этапе проектирования не выполнялись.

**3. Целевая архитектура**

~~~mermaid
flowchart TD
  UI["PWA: чат / задачи / настройки"] --> API["Fastify: auth, REST, WS"]
  API --> CHAT["ChatService + ModePolicy"]
  API --> TASK["TaskService / NoteService"]
  API --> FILES["AttachmentService"]
  CHAT --> CONTEXT["ChatContextBuilder"]
  CHAT --> PROVIDERS["ProviderRegistry + adapters"]
  CHAT --> TASK
  CONTEXT --> INDEX["Поисковый индекс / граф / задачи"]
  TASK --> WRITE["VaultMutationService"]
  FILES --> WRITE
  WRITE --> VAULT["Markdown + assets + Git"]
  VAULT --> INDEX
  API --> TEMP["Временная история: chat.sqlite + файлы"]
  SCHED["Persistent Scheduler"] --> ORGANIZER["OrganizerService"]
  ORGANIZER --> PROVIDERS
  ORGANIZER --> WRITE
  SCHED --> DIGEST["WeeklyDigestService + SmsAdapter"]
  DIGEST --> INDEX
~~~

Один модульный сервер и один worker в первом релизе достаточны. Очередь заданий находится в SQLite; не вводить Redis, Kubernetes и микросервисы без измеренной необходимости. OCR/парсинг больших файлов выполняется вне event loop HTTP-сервера.

Три разных вида данных:

| Данные | Хранилище | Срок / источник истины |
|---|---|---|
| Заметки, задачи, люди, теги, ссылки, оригиналы сохранённых вложений | Vault + Git | Постоянно, это источник истины |
| Сообщения, tool results, summary, факты памяти, task drafts, временные вложения/OCR | chat.sqlite + каталог вне vault | Не более 14 дней по происхождению данных |
| Профили/зашифрованные ключи, расписания, jobs, журнал операций, настройки | relay.sqlite / secrets | До удаления или установленной технической политики |
| Индексы заметок/задач/ссылок | relay.sqlite, отдельные таблицы | Перестраиваются из vault; не второй источник истины |

Индексы содержат только разрешённые файлы vault. История, ключи, временные uploads и тела диагностических логов никогда не попадают в Git. Приватные папки исключаются и из индекса, и из контекста модели.

**4. Сквозные контракты**

Ниже — контракты TypeScript, а не готовая реализация. Все идентификаторы непрозрачные строки; время передаётся как ISO 8601 UTC, календарные даты — YYYY-MM-DD. IanaTimezone валидируется как IANA timezone. Path означает нормализованный относительный путь vault.

~~~ts
type Id = string;
type Instant = string;
type LocalDate = string;
type IanaTimezone = string;
type ContentHash = string;
type GitSha = string;
type ChatMode = 'task' | 'note';
type Category = 'study' | 'work' | 'personal';
type Priority = 'highest' | 'high' | 'medium' | 'low';
type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

interface ActorContext {
  workspaceId: Id;
  deviceId: Id;
  permissions: string[];
}

interface MutationContext {
  actor: ActorContext;
  operationId: Id;
  expectedContentHash?: ContentHash;
}

interface ApiFailure {
  code: string;
  message: string;
  retryable: boolean;
  requestId: Id;
  fieldErrors?: Record<string, string>;
  retryAfterSeconds?: number;
}

interface ArtifactRef {
  id: Id;
  kind: 'task' | 'note' | 'person' | 'attachment';
  path: string;
  contentHash: ContentHash;
}

interface MutationReceipt {
  operationId: Id;
  artifacts: ArtifactRef[];
  state: 'saved_local' | 'committed' | 'synced' | 'conflict';
  commitSha?: GitSha;
  syncError?: ApiFailure;
}
~~~

Инварианты:

- Все мутации проходят серверную авторизацию, проверку входной схемы и бизнес-правил. Prompt не заменяет эти проверки.
- Один operationId/requestId и одинаковое тело запроса дают один эффект. То же ID с другим телом — 409 IDEMPOTENCY_KEY_REUSED.
- После истечения временного request сохраняется бесконтентный durable tombstone: workspaceId, requestId, fingerprint запроса, operationIds, terminalStatus. Старый retry возвращает ссылки на сохранённые artifacts либо REQUEST_EXPIRED для уже удалённого ответа; повторный агент не запускается. Тексты/промежуточные результаты в tombstone не хранятся.
- workspaceId и deviceId выводятся из авторизации; клиент не может назначить себе владельца через JSON.
- Сохранение файла и успешный push — разные состояния. UI не показывает «Синхронизировано», пока push не подтверждён.
- Изменение существующей сущности требует версии содержимого. Конфликт возвращает актуальную версию без потери пользовательского черновика.

**5. Провайдеры и настройки моделей**

Профиль содержит endpoint, adapter, modelId, лимиты и ссылку на секрет. Публичный DTO никогда не содержит API-ключ.

~~~ts
type ProviderSlot = 'chat' | 'organizer';
type AdapterKind = 'openai_compatible' | 'anthropic' | 'gemini';

interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  toolCalls: boolean;
  structuredOutput: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

interface ProviderPublic {
  id: Id;
  slot: ProviderSlot;
  name: string;
  adapter: AdapterKind;
  baseUrl: string;
  modelId: string;
  canonicalModelId: string | null;
  capabilities: ModelCapabilities;
  hasSecret: boolean;
  enabled: boolean;
  version: number;
}

interface ProviderWrite {
  name: string;
  adapter: AdapterKind;
  baseUrl: string;
  modelId: string;
  secretUpdate:
    | { action: 'keep' }
    | { action: 'replace'; apiKey: string }
    | { action: 'remove' };
  expectedVersion?: number;
}

interface ModelBindingSnapshot {
  providerId: Id;
  providerVersion: number;
  modelId: string;
  canonicalModelId: string | null;
}

interface ProviderRegistry {
  list(actor: ActorContext): Promise<ProviderPublic[]>;
  create(slot: ProviderSlot, input: ProviderWrite, actor: ActorContext): Promise<ProviderPublic>;
  update(id: Id, input: ProviderWrite, actor: ActorContext): Promise<ProviderPublic>;
  test(id: Id, actor: ActorContext): Promise<ProviderTestResult>;
  resolve(binding: ModelBindingSnapshot): Promise<LlmAdapter>;
}

interface LlmAdapter {
  generate(request: NormalizedLlmRequest, signal: AbortSignal): AsyncIterable<NormalizedLlmEvent>;
}
~~~

ProviderTestResult возвращает availability, verifiedCapabilities, warnings, checkedAt; NormalizedLlmRequest содержит system instructions, сообщения text/image, tool schemas, budget; события — text_delta/tool_call/usage/completed/error. Внутренние DTO поставщика остаются внутри адаптера.

Контроль и поведение:

- Лимит пять chat-профилей и один organizer обеспечивается серверной транзакцией. Выключенный сохранённый профиль также занимает слот.
- На настройках выбирается провайдер чата по умолчанию; существующему чату можно поменять привязку. Во время одного запроса привязка неизменна.
- provider_versions хранит неизменяемые версии полной конфигурации и зашифрованного секрета, используемые незавершёнными runs/jobs. Смена ключа не подменяет snapshot; старую версию удалить после завершения зависимостей. Явный отзыв скомпрометированного ключа отменяет связанные runs и удаляет секрет; recovery не должен использовать отозванную версию.
- Секрет хранить зашифрованным, master key — отдельный secret deployment, не в той же БД. В логах и ошибках удалять ключи/Authorization и query secrets.
- Удаление занятого профиля: 409 PROVIDER_IN_USE со списком зависимостей; UI предлагает выбрать замену или отключить сортировку. Уже начатый запрос завершается на своей версии либо явно отменяется.
- «Проверить подключение» выполняет ограниченный тест; успешный HTTP-запрос не доказывает поддержку vision/tool calls. Не выбирать неподдерживаемую возможность по одному имени модели.
- Сортировщику нужны structured output или проверяемый JSON-протокол и чтение контекста. Если модель не может пройти схему плана, запуск не меняет vault.
- Для одинаковой модели через разные API использовать canonicalModelId. Если сопоставление неизвестно, показать «различие моделей не проверено» и запросить выбор явных моделей; не заявлять автоматическую проверку по разным URL.
- Другая базовая модель, совпавшая с organizer после переключения, блокирует автоматическую сортировку до изменения organizer; чат продолжает работать.
- Не выполнять скрытый fallback к другому поставщику: это меняет получателя данных. Ошибка ключа/квоты показывается с возможностью явного переключения.
- URL проверяется против SSRF: HTTPS по умолчанию, ограничения на redirects/DNS/private/link-local адреса. Локальный Ollama разрешается только серверным allowlist конкретного адреса, независимо от настроек мобильного клиента.
- Существующий OpenAI-compatible адаптер — первый этап. Anthropic/Gemini включать в UI только после реализации и контрактных тестов их отдельных адаптеров. Произвольный URL не делает произвольный API совместимым.

**6. Модель задачи и обязательный дедлайн**

Одна новая управляемая задача — один Markdown-файл со стабильным relay_id. SQLite хранит проекцию для фильтров и представлений.

~~~ts
type Deadline =
  | { kind: 'by_date'; date: LocalDate; timezone: IanaTimezone }
  | { kind: 'by_time'; at: Instant; timezone: IanaTimezone }
  | { kind: 'at_time'; at: Instant; timezone: IanaTimezone };

interface Task {
  id: Id;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  status: TaskStatus;
  deadline: Deadline;
  keywords: string[];
  tags: string[];
  relatedNoteIds: Id[];
  createdAt: Instant;
  updatedAt: Instant;
  completedAt: Instant | null;
  path: string;
  contentHash: ContentHash;
  fieldOrigins: Record<string, 'user' | 'inferred' | 'default'>;
}

interface TaskDraft {
  id: Id;
  chatId: Id;
  originRequestId: Id;
  version: number;
  state: 'collecting' | 'ready' | 'committing' | 'committed' | 'cancelled';
  committedTaskId: Id | null;
  committedOperationId: Id | null;
  values: Partial<Pick<Task, 'title' | 'description' | 'category' | 'priority' | 'deadline'>>;
  missingFields: string[];
  ambiguousFields: string[];
  referenceInstant: Instant;
  deadlineSourceMessageId: Id | null;
  timezone: IanaTimezone;
  expiresAt: Instant;
}

type TaskInterpretation =
  | { kind: 'needs_input'; draft: TaskDraft; question: string }
  | { kind: 'ready'; task: TaskCreateInput; draftId: Id; draftVersion: number };

type TaskCreateInput = Pick<Task,
  'title' | 'description' | 'category' | 'priority' | 'deadline' | 'keywords' | 'tags' | 'relatedNoteIds'
>;

interface TaskService {
  interpret(text: string, context: TaskInterpretContext): Promise<TaskInterpretation>;
  resolveDraft(id: Id, reply: string, expectedVersion: number, context: TaskInterpretContext): Promise<TaskInterpretation>;
  commitDraft(id: Id, expectedVersion: number, context: MutationContext): Promise<MutationReceipt>;
  create(input: TaskCreateInput, context: MutationContext): Promise<MutationReceipt>;
  update(id: Id, patch: TaskPatch, context: MutationContext): Promise<MutationReceipt>;
  list(query: TaskQuery, actor: ActorContext): Promise<TaskPage>;
}
~~~

TaskInterpretContext содержит actor, chatId, requestId, messageId, referenceInstant, timezone, binding, draftId; TaskPatch разрешает только редактируемые поля; TaskQuery — status/category/priority/deadline range, includeLegacy, sort, cursor, limit. TaskPage возвращает items, nextCursor, indexRevision.

commitDraft резервирует уникальную durable-операцию по draftId и переводит draft из ready в committing через CAS версии. После успешной записи — committed с taskId/operationId. Это протокол восстановления, а не общая транзакция двух БД и Git. Два разных requestId, отвечающих на один draft, возвращают одну задачу; уникальность draftId в журнале предотвращает дубликат даже после crash.

Правила дедлайна:

- by_date: «до 10 октября» означает включительно указанную дату в выбранном часовом поясе. Просрочка наступает в начале следующего локального дня; не подставлять 23:59:59.
- by_time: «до 10 октября 17:00» — крайний момент выполнения.
- at_time: «10 октября в 17:00» — задача на конкретное время. В календаре это отметка времени, без выдуманной длительности.
- «К пятнице», «вечером», «через неделю» при неоднозначности требуют уточнения. Относительный срок рассчитывается от времени сообщения, в котором он задан, а не от времени retry или первой реплики draft. Сохранить deadlineSourceMessageId и referenceInstant этой реплики: задача сформулирована в понедельник, ответ «до завтра» во вторник — срок в среду.
- «Купить учебник» → создать только TaskDraft, спросить срок. После «до завтра» продолжить этот draft, а не заводить вторую задачу.
- Дедлайн не может быть придуман моделью. Если дата прошла, спросить один раз, намеренно ли создаётся просроченная задача; подтверждение привязать к версии draft.
- Срок обязателен в AI, ручной форме, REST, WS и быстрых маршрутах. Старый /task или append_daily(as_task) не должен обходить TaskService.
- Категория: Учёба / Работа / Личное. Приоритет: Наивысший / Высокий / Средний / Низкий. В UI — русские названия, в DTO — enum.
- Если метки не заданы, ИИ определяет их по контексту. При полном отсутствии признаков — personal/medium с происхождением default и видимой возможностью исправить. Не задавать дополнительные вопросы только ради меток.
- Наивысший приоритет не выставляется автоматически только из-за просрочки. Явная метка пользователя имеет приоритет над inference.
- Завершение → completedAt; возврат в работу → completedAt=null. cancelled не участвует в SMS. «Просрочено» — вычисляемый признак, не отдельная колонка канбана.
- Смена timezone в общих настройках влияет на новые задачи и представление времени, но не сдвигает сохранённый Instant и не меняет timezone уже существующего by_date без явного редактирования.

Пример канонического результата, не программная реализация:

~~~yaml
---
relay_schema: 1
relay_id: task_01
type: task
title: Подготовить отчёт
category: work
priority: high
status: todo
deadline_kind: by_time
deadline_at: "2026-10-05T14:00:00Z"
deadline_timezone: Europe/Moscow
created_at: "2026-10-02T09:00:00Z"
updated_at: "2026-10-02T09:00:00Z"
tags: [area/work, priority/high]
keywords: [отчёт, проект]
---
~~~

Метаданные редактировать YAML/Markdown-парсером с сохранением неизвестных полей и тела. status и canonical category/priority — источник для нормализованных меток; валидатор выявляет рассогласование при ручном редактировании. На by_date вместо deadline_at используется deadline_date; сериализатор не сохраняет поля другой ветви union.

Существующие checkboxes без срока не преобразовывать молча в новые Task. Индексировать их отдельным LegacyTask с originPath/block locator/contentHash, показать «Нужен срок», сохранить исходный текст. При конвертации заменить старый checkbox ссылкой на созданную задачу в одной операции, чтобы не получить дубликат. Некорректный Markdown с type: task из Obsidian показывать как invalid record с причинами.

Legacy extraction не разбирает code fences, цитаты, type: document и помеченные импортированные source-блоки. Чекбоксы из документа не становятся пользовательскими задачами автоматически; их создание — отдельное действие с обязательным сроком.

**7. Заметки, команды, люди и связность**

~~~ts
type NoteKind = 'quick' | 'idea' | 'person' | 'note' | 'document';

interface NoteInput {
  kind: NoteKind;
  title: string;
  body: string;
  category?: Category;
  keywords?: string[];
  tags?: string[];
  folderHint?: string;
  relatedNoteIds?: Id[];
  attachmentIds?: Id[];
}

interface NoteMetadata {
  id: Id;
  schemaVersion: number;
  kind: NoteKind;
  keywords: string[];
  tags: string[];
  relatedNoteIds: Id[];
  lockedFields: string[];
  enrichmentState: 'complete' | 'pending' | 'needs_review';
}

interface NoteService {
  create(input: NoteInput, context: MutationContext): Promise<MutationReceipt>;
  proposeEdit(id: Id, instruction: string, context: NoteEditContext): Promise<NotePatchPlan>;
  applyEdit(plan: NotePatchPlan, context: MutationContext): Promise<MutationReceipt>;
  findPerson(query: PersonQuery, actor: ActorContext): Promise<PersonCandidate[]>;
}

interface SlashCommandSpec {
  name: 'quick' | 'idea' | 'person';
  mode: 'note';
  description: string;
  handler: string;
}
~~~

NoteEditContext содержит actor, binding и expectedContentHash. NotePatchPlan содержит targetId, baseHash, изменения metadata/конкретных блоков и причины. PersonQuery — имя, aliases и явно переданные идентификаторы; PersonCandidate — noteId, совпавшие поля и основания совпадения.

Если целевой файл имеет type: task, общая запись через NoteService запрещена: запрос переводится в TaskService с его схемами и разрешениями режима либо возвращает MODE_ACTION_NOT_ALLOWED. Любые серверные patches, включая organizer metadata/move, повторно проверяют task-инварианты. Внешние некорректные правки Obsidian помечаются invalid, без молчаливого исправления.

| Команда | Назначение | Поведение |
|---|---|---|
| /quick | Быстрая заметка | Сохранить исходную мысль, добавить минимальные keywords, подобрать папку и ссылки |
| /idea | Идея | Структура «Суть / Контекст / Следующий шаг», без придуманных фактов |
| /person | Карточка человека | Найти кандидатов, добавить нового или дополнить выбранного |

Палитра появляется над composer при начальном «/», работает только в режиме заметки. Сервер также проверяет режим. Старые пользовательские сценарии не могут предоставлять дополнительные write tools или обходить дедлайн; конфликт имён с тремя командами разрешается в пользу встроенной команды с уведомлением.

Обогащение каждой записи:

1. Извлечь 3–8 осмысленных ключевых слов, нормализовать регистр и дубликаты. Для очень короткого текста допускается меньше.
2. Искать кандидатов по ключевым словам, названиям, aliases и тегам в полном разрешённом индексе.
3. Выбрать до пяти содержательно связанных заметок. Самоссылки и фиктивные ссылки запрещены; отсутствие подходящих соседей нормально.
4. Выбрать существующую папку по правилам vault. При низкой уверенности — осмысленный временный раздел Inbox с pending/needs_review.
5. Сохранить keywords, tags и раздел связанных заметок. Вручную выставленные связи/метки не удалять.
6. Обновить индекс и автоматически доступные backlinks. Не нужно дописывать обратную ссылку в каждый соседний файл.

Предлагаемые корни для пустого vault: Areas/Study, Areas/Work, Areas/Personal; People; Projects; Resources; Inbox; Archive; _attachments. Для существующего vault сначала построить карту текущих папок, aliases и правил; не навязывать новую структуру всему хранилищу.

Иерархия: ограниченная конфигурация корневых папок, category/project/type и тематические index/MOC-заметки. Не создавать новую папку на каждое ключевое слово. Поле folderLocked и lockedFields защищает вручную заданное расположение и metadata.

/person не объединяет тёзок автоматически. При нескольких кандидатах показать выбор; при спорном изменении сохранить source/evidence и предложить уточнение. Не придумывать биографию и не включать внешний поиск людей.

Если LLM временно недоступна, ручная заметка и /quick сохраняют исходный текст с детерминированными keywords, поиском по индексу и enrichmentState=pending. Позднее worker дополняет metadata. ИИ-задача без надёжно установленного срока остаётся draft.

**8. Режимы ИИ: политика и контракт исполнения**

~~~ts
interface ModePolicy {
  mode: 'task' | 'note' | 'organizer';
  allowedTools: string[];
  systemPromptVersion: string;
  outputSchema: string;
  maxToolRounds: number;
  maxInputTokens: number;
}

interface AgentRunInput {
  actor: ActorContext;
  requestId: Id;
  chatId: Id;
  mode: ChatMode;
  binding: ModelBindingSnapshot;
  text: string;
  attachmentIds: Id[];
  draftId?: Id;
  expectedDraftVersion?: number;
  referenceInstant: Instant;
  timezone: IanaTimezone;
}
~~~

| Режим | Разрешённые действия | Обязательные правила |
|---|---|---|
| task | Поиск заметок/задач, извлечение TaskDraft, запрос уточнения, создание/обновление через TaskService | Нет финальной задачи без срока; не менять заметки произвольным write tool |
| note | Поиск, чтение, /quick, /idea, /person, предложенные правки через NoteService, импорт документа | Сохранить исходные факты, keywords и связи; выбор при неоднозначном объекте |
| organizer | Снимок индекса, чтение выбранных заметок и соседей, возврат OrganizationPlan | Не менять дедлайны/статусы/текст фактов; нет SMS tool и произвольного файлового доступа |

Режим organizer запускается worker, не предоставляется как третий пользовательский chat mode.

System prompt строится из общих ограничений, ModePolicy, времени/timezone, структуры vault и текущего контекста. Содержание заметок, файлов и OCR — данные, не команды агенту. Сценарии пользователя добавляются после обязательных правил и не расширяют права.

И tool calls, и прямые slash-команды проходят один сервисный слой. Невалидный JSON → максимум одна попытка исправить по схеме, затем понятная ошибка без записи. Не хранить скрытые рассуждения модели; история включает запросы, ответы и необходимые результаты инструментов.

**9. Чаты, 14 дней хранения и память**

~~~ts
interface Chat {
  id: Id;
  workspaceId: Id;
  title: string;
  defaultMode: ChatMode;
  providerId: Id;
  createdAt: Instant;
  lastActivityAt: Instant;
}

interface ChatMemoryFact {
  id: Id;
  chatId: Id;
  text: string;
  sourceMessageIds: Id[];
  noteRefs: { noteId: Id; path: string; contentHash: ContentHash }[];
  expiresAt: Instant;
}

interface ChatSendRequest {
  requestId: Id;
  chatId: Id;
  mode: ChatMode;
  text: string;
  attachments: { id: Id; purpose: 'context' | 'full_note' }[];
  draftId?: Id;
  expectedDraftVersion?: number;
}

interface ChatEventEnvelope {
  requestId: Id;
  chatId: Id;
  sequence: number;
}

type ChatEvent = ChatEventEnvelope & (
  | { type: 'accepted'; payload: { userMessageId: Id } }
  | { type: 'progress'; payload: { stage: string; text: string } }
  | { type: 'text_delta'; payload: { text: string } }
  | { type: 'needs_input'; payload: { draftId: Id; draftVersion: number; fields: string[]; question: string } }
  | { type: 'result'; payload: { assistantMessageId: Id; text: string; receipts: MutationReceipt[] } }
  | { type: 'error'; payload: ApiFailure }
);

interface ChatContextBuilder {
  build(input: AgentRunInput, tokenBudget: number): Promise<ChatContext>;
  invalidateNote(noteId: Id, newHash: ContentHash | null): Promise<void>;
  prune(now: Instant): Promise<RetentionReport>;
}
~~~

ChatContext содержит summary оставшейся истории, последние сообщения, facts, активный draft, ссылки/фрагменты заметок и их hashes. Memory — вспомогательный кэш, не самостоятельный источник фактов.

Состав контекста: системные правила → выбранный режим → summary → последние реплики → активный draft → релевантные note refs. При нехватке токенов сокращать историю и количество фрагментов, не обязательные правила и не поля дедлайна.

Не перечитывать .md можно, если запрос относится к действующей информации чата или проверенный hash заметки совпадает. После Git pull, записи/rename/delete индексы и refs инвалидируются. Перед редактированием всегда читать актуальную версию целевого файла. Если синхронизация remote не прошла, интерфейс сообщает, что используется локально известная версия.

Политика удаления:

- У каждого сообщения expiresAt = createdAt + 14 суток; чтение и context building фильтруют истёкшие строки независимо от уборщика.
- Производный факт/summary segment истекает не позже самой ранней даты истечения исходных сообщений. Новая суммаризация не продлевает срок старых данных.
- Для факта, полученного только из заметки, TTL не больше 14 дней от извлечения; актуальность по contentHash проверяется независимо. Бессрочное хранение копии содержимого заметки в памяти чата не требуется.
- Предпочтительно сегментировать summary по происхождению. При удалении источника удалить зависимые факты и пересобрать summary из ещё действующей истории.
- Generated chat title тоже является производными данными: пересобрать либо заменить на нейтральное название при истечении его источников.
- TaskDraft не переживает источники, из которых извлечены его поля. Просроченный draft нельзя «оживить» одним ответом; пользователь получает сообщение о необходимости повторного ввода.
- Временный attachment, OCR и provider-side upload истекают по собственной дате приёма, не позднее 14 дней. Повторное использование не продлевает TTL; удаление раньше допустимо, когда нет живых ссылок.
- Удаление чата сразу удаляет его историю, memory, drafts и непривязанные к другим действующим объектам временные файлы. Git-результаты остаются.
- Пустые неактивные чаты удаляются через 14 дней после последней активности. Работающий чат может жить дольше, но содержит только действующее окно.
- Уборщик запускается при старте и не реже раза в час. Логическое исключение из API происходит точно по expiresAt; операционный норматив очистки файлов/строк — не позднее часа после истечения.
- chat.sqlite и temp uploads исключены из постоянных бэкапов. Не записывать тексты чатов в логи, crash dumps и APM. Очистить WAL/free pages по документированной политике; SQL DELETE сам по себе не обещает физическое стирание всех копий.
- Для буквальной гарантии недоступности за пределами 14 дней: шифровать временные payload с ключами сегментов по времени/зависимостям, уничтожать ключи в срок, исключить их из backups. Регулярно проверять восстановление БД не возвращает истёкшие данные.
- Браузерный кэш истории тоже ограничить TTL; API отвечает no-store, service worker не кэширует историю/секреты/временные файлы. Offline-кэш не должен бессрочно показывать удалённые сообщения.
- Политика сервера не определяет хранение у внешнего LLM-поставщика; учитывать возможности удаления provider-side uploads и настройки хранения каждого адаптера, показывать эту границу в настройках.

**10. Фото и документы**

~~~ts
type ExtractionState = 'queued' | 'processing' | 'ready' | 'partial' | 'failed';

interface Attachment {
  id: Id;
  workspaceId: Id;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  state: ExtractionState;
  temporaryExpiresAt: Instant | null;
  extraction: {
    pageCount: number | null;
    processedPages: number[];
    unreadablePages: number[];
    textArtifactId: Id | null;
    warnings: string[];
  };
  persistedArtifact?: ArtifactRef;
}

interface AttachmentService {
  upload(input: UploadStream, actor: ActorContext): Promise<Attachment>;
  extract(id: Id, actor: ActorContext): Promise<Attachment>;
  importToNote(id: Id, input: NoteInput, context: MutationContext): Promise<MutationReceipt>;
}

interface VaultAsset {
  id: Id;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  sourceNoteIds: Id[];
}
~~~

UploadStream содержит поток байтов, заявленные filename/content type/size; доверять нужно фактическому формату и измеренному размеру.

Два разных действия:

- «Для разговора»: временный файл и извлечённый текст используются в контексте; в Git не копируются.
- «Полностью в заметку»: оригинал копируется в _attachments с hash/manifest, весь доступный извлечённый текст переносится в .md, изображения/таблицы сохраняются или явно отмечаются как нераспознанные. Заметка ссылается на оригинал. Это не краткий пересказ.

После импорта создаётся постоянный VaultAsset со своим id, manifest в Git и восстановимой проекцией asset_index. Заметка и download route ссылаются на assetId/path, а не на временный upload ID. Истечение Attachment или удаление чата не удаляет VaultAsset и не ломает просмотр оригинала. Временная копия удаляется отдельно после подтверждённого копирования.

Поддержка первого релиза: JPEG/PNG/WebP, TXT/MD, PDF, DOCX; HEIC — при подключённом проверенном конвертере, иначе явная ошибка формата. Стартовые лимиты конфигурации: 20 MiB/файл, 5 файлов/запрос, 100 страниц/документ, 10 параллельных ожидающих uploads на workspace. Ограничения видны до отправки; тяжёлые PDF обрабатываются страницами.

PDF с текстовым слоем → parser; scan/photo → OCR; DOCX → paragraphs/tables/images. Извлечённый полный текст переносится детерминированно, а модель отвечает только за структурирование/metadata. Не прогонять весь документ через prompt с фиксированным лимитом и не использовать текущий read_note с обрезкой для полного импорта.

Для очень длинного документа допустим index.md + страницы/разделы с навигацией и manifest, но без потери частей. Manifest хранит checksum оригинала, число страниц, покрытие, warnings и версию extractor. Статус complete означает обработку всех частей, не гарантирует безошибочный OCR.

Если часть страниц не распознана: сохранить оригинал, показать partial и номера страниц; готовая задача импорта не должна заявлять «всё перенесено». Повторная обработка адресует пропущенные части. Повреждённый/запароленный документ даёт конкретную ошибку; не угадывать содержимое.

Файлы выдаются только авторизованным маршрутом. Проверять MIME magic, лимиты декомпрессии DOCX/PDF, время/память OCR, опасные имена и активный контент. HTML/Markdown preview санитизировать. Оригинал документа с активным содержимым не исполнять на сервере.

В режиме task вложение служит контекстом задачи. «Полностью в заметку» запускает явный переход/отдельную note-операцию, чтобы обходом UI не расширять task allowlist.

**11. Единый механизм записи и Git**

~~~ts
type VaultOperation =
  | { kind: 'create'; path: string; content: string; mustNotExist: true }
  | { kind: 'update'; path: string; baseHash: ContentHash; content: string }
  | { kind: 'move'; from: string; to: string; baseHash: ContentHash }
  | { kind: 'put_asset'; path: string; attachmentId: Id; sha256: string };

interface VaultChangeSet {
  operationId: Id;
  expectedHead: GitSha | null;
  operations: VaultOperation[];
  reason: 'task' | 'note' | 'import' | 'organizer' | 'migration';
}

interface VaultMutationService {
  validate(changes: VaultChangeSet, actor: ActorContext): Promise<ValidationReport>;
  apply(changes: VaultChangeSet, actor: ActorContext): Promise<MutationReceipt>;
  getOperation(operationId: Id, actor: ActorContext): Promise<MutationReceipt>;
  recoverIncomplete(): Promise<RecoveryReport>;
}
~~~

Нет общей ACID-транзакции между SQLite, файловой системой и Git. Нужен явный журнал состояний:

1. Зафиксировать operationId, hash запроса, план и ожидаемые версии.
2. Под workspace lock сверить hashes/HEAD и разрешённые пути; поздние изменения делают план устаревшим.
3. Подготовить временные файлы и backup references; проверить весь change set до применения.
4. Применить записи/перемещения, проверить результат и создать Git commit с trailer Relay-Operation-Id.
5. Обновить проекции/журнал БД; после сбоя восстановить их по commit и operationId.
6. Поставить push в устойчивую очередь. Подтверждение push меняет состояние на synced.

Одна запись файла через tmp+rename не делает несколько файлов транзакцией. На старте recovery завершается до открытия мутаций; чтение не должно видеть частичный change set. Для крупной сортировки готовить изменения в staging/worktree, затем применять проверенный commit под lock. Не держать lock всё время LLM-вызова.

Все REST/WS/direct commands/quick capture/worker/Git pull используют один координатор записи. Убрать текущее неограниченное git add -A для прикладных операций: коммитить явный набор проверенных путей. Чужие изменения сначала обнаружить и отдельно обработать.

После failed push сохранять commit локально и показывать pending, не создавать результат повторно. При remote ahead — fetch/проверяемый merge, при конфликте остановить публикацию конфликтных изменений и запросить разрешение через UI. Не использовать force push и не считать «оставили ours» успешным разрешением структурных конфликтов.

История journal не хранит разговоры. Payload незавершённой операции очищается после завершения или TTL; для дедупликации достаточно operationId, hashes и commit refs. При recovery после commit, но до обновления БД trailer предотвращает повторное создание.

SYNC_MODE=none сохраняется для разработки: обычные операции возвращают saved_local. Автоматическая Git-сортировка требует Git и настроенного remote, иначе CONFIG_GIT_REQUIRED; для её локальных интеграционных тестов используется bare remote.

**12. Сортировка по средам и воскресеньям**

~~~ts
interface OrganizerSettings {
  enabled: boolean;
  providerId: Id; // Только профиль slot=organizer.
  timezone: IanaTimezone;
  weekdays: number[]; // ISO: 1=понедельник ... 7=воскресенье.
  localTime: string; // По умолчанию 23:59.
  maxNotesPerBatch: number;
  maxChangedFilesPerRun: number;
  maxTokensPerRun: number;
  folderRulesVersion: number;
  version: number;
}

interface OrganizerCheckpoint {
  workspaceId: Id;
  lastSuccessfulHead: GitSha | null;
  policyVersion: number;
  completedAt: Instant | null;
}

interface NoteOrganizationPatch {
  noteId: Id;
  baseHash: ContentHash;
  targetPath?: string;
  addTags: string[];
  keywords?: string[];
  addRelatedNoteIds: Id[];
  rationale: string;
}

interface OrganizationPlan {
  runId: Id;
  inputHead: GitSha | null;
  policyVersion: number;
  patches: NoteOrganizationPatch[];
  affectedBacklinkPaths: string[];
  deferredNoteIds: Id[];
}

interface OrganizerService {
  plan(input: OrganizationInput, signal: AbortSignal): Promise<OrganizationPlan>;
  validate(plan: OrganizationPlan): Promise<ValidationReport>;
  apply(plan: OrganizationPlan): Promise<MutationReceipt>;
}
~~~

OrganizationInput: разрешённый snapshot inputHead, изменённые IDs/paths, ограниченный набор релевантных соседей, карта папок, lockedFields, budget и binding сортировщика.

Алгоритм:

1. Устойчивый scheduler создаёт job с ключом workspaceId + kind + localOccurrenceId. Occurrence — календарная дата и логический слот расписания; scheduleVersion хранится отдельно для отмены устаревших jobs и не снимает дедупликацию уже выполненного occurrence.
2. Проверить enabled, отдельный профиль, доступность модели и лимиты. Убедиться, что предыдущий запуск завершён или восстановлен.
3. Завершить предыдущие локальные мутации и синхронизировать remote. При sync conflict сортировка не начинает массовую запись.
4. Зафиксировать inputHead. Вычислить изменения относительно lastSuccessfulHead через Git diff со статусами add/modify/rename/delete и NUL-разделением.
5. Даты коммитов показывать в UI/аудите. **Не использовать mtime или commit dates как единственный критерий отбора**: диапазон SHA задаёт точные состояния. Git умеет сравнивать два коммита и выдавать имена/статусы файлов. [git-diff](https://git-scm.com/docs/git-diff).
6. Обновить индекс для новых/изменённых файлов; удалённые исключить, переименованные связать по стабильному relay_id. Строить план только для изменённых кандидатов. Весь разрешённый индекс доступен для поиска соседей; это не повторный LLM-анализ всего vault.
7. Передать сортировщику ограниченные пакеты кандидатов и найденных соседей. Он возвращает структурированные patches, не shell-команды и не произвольный текст замены файлов.
8. Проверить соответствие схемам, существование ссылок, разрешённость папок, отсутствие collisions, защиту lockedFields, лимит изменений и сохранность фактического текста.
9. Для move обновить входящие wikilinks, Markdown links, embeds и относительные пути вложений во всех затронутых файлах. Сохранить aliases, heading/block anchors. Это детерминированная операция по графу ссылок, а не повторное «обдумывание» старых заметок.
10. Под lock выполнить CAS: HEAD и hashes должны совпасть с планом. Если пользователь или sync изменили snapshot, пересчитать план; не переносить checkpoint на новый HEAD автоматически.
11. Создать commit с runId, inputHead и operationId. Только после проверки целостности и успешной публикации записать lastSuccessfulHead = resultCommit.
12. При отсутствии изменений — зафиксировать проверенный inputHead без пустого commit. В штатном следующем запуске собственные metadata изменения не должны вновь разбирать весь vault.

resultCommit означает именно коммит проверенного плана, построенный поверх inputHead. Если публикация потребовала merge новых remote-изменений, нельзя подменять checkpoint SHA этого merge: новые remote-файлы ещё не классифицированы и должны войти в следующий diff от resultCommit. При конфликтном merge возобновить публикацию после разрешения; при переписывании истории коммита выполнить reconciliation.

Первый запуск: полный первичный индекс и однократная пакетная классификация разрешённых заметок. До запуска показать объём и лимит; после настройки пользователь может включить автоматический режим. Для существующего большого vault первый проход продолжается несколькими jobs с общей контрольной точкой.

Пакеты и ошибки: обработанные content hashes + policyVersion кэшировать, оставшиеся кандидаты сохранять в pending queue. Если часть не обработана, не продвигать глобальный checkpoint за неё; retry использует кэш и не повторяет удачные LLM-вызовы. deferred/needs_review не считается обработанным без явного решения/исключения по правилу.

Если checkpoint отсутствует в истории или перестал быть предком HEAD после rewrite: остановить инкрементальный режим, выполнить reconciliation по ID/content hash и восстановить безопасный baseline. Не объявлять «изменений нет».

Переименование на сервере требует собственного обновления ссылок: нельзя рассчитывать на автоматическую коррекцию пользовательским Obsidian, который может быть выключен. Неоднозначные ссылки при совпадении названий — причина отложить move и показать проверку.

Сортировщик может добавлять metadata, связи, перемещать заметки и обновлять тематические индексы. Он не удаляет заметки, не объединяет людей автоматически, не переписывает факты и не завершает задачи. Пакеты сверх лимита остаются в очереди и видны в статусе.

Повторный запуск после собственного результата должен дать нулевой семантический diff. Изменение правил сортировки повышает policyVersion и запускает отдельный контролируемый reindex/reclassification.

**13. Scheduler, SMS и недельный чек-лист**

~~~ts
interface ScheduledJob {
  id: Id;
  kind: 'organize' | 'weekly_digest' | 'retention' | 'extract' | 'git_push' | 'enrich';
  scheduledFor: Instant;
  dedupeKey: string;
  scheduleVersion: number;
  localOccurrenceId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  attempt: number;
  leaseUntil: Instant | null;
  leaseOwner: string | null;
  fencingToken: number;
  lastErrorCode: string | null;
}

interface SmsSettings {
  enabled: boolean;
  recipientE164: string;
  verifiedAt: Instant | null;
  gatewayProfileId: Id;
  timezone: IanaTimezone;
  weekday: number;
  localTime: string;
  maxItems: number;
  maxSegments: number;
  version: number;
}

interface WeeklyDigest {
  id: Id;
  periodStart: Instant;
  periodEndExclusive: Instant;
  generatedAt: Instant;
  taskIds: Id[];
  omittedCount: number;
  text: string;
}

interface SmsAdapter {
  send(input: { to: string; text: string; idempotencyKey: string }): Promise<SmsSendResult>;
  getStatus(providerMessageId: string): Promise<SmsDeliveryStatus>;
}
~~~

SmsSendResult различает accepted/rejected/unknown и возвращает providerMessageId при наличии; delivery callback имеет проверяемую подпись. «Принято шлюзом» и «Доставлено» — разные статусы.

Правило отбора по умолчанию: на момент отправки незавершённые задачи со сроком в текущей локальной неделе понедельник–воскресенье плюс более ранние просроченные. Исключить done/cancelled. Задачи с невалидным/неизвестным сроком вынести в приложение, не выдумывать их неделю.

Порядок: highest → high → medium → low, затем срок и id. Первые пять коротких названий с датами; остаток — «ещё N». Максимум два SMS-сегмента по оценке конкретного шлюза; при длинном русском тексте сокращать названия/количество, а не отправлять неограниченную серию.

Чек-лист строится обычным запросом к индексу задач, модель для SMS не нужна. Если нет незавершённых задач — сообщение не отправляется, job получает skipped_empty в результате. Состояние задач проверить ещё раз перед отправкой.

При 23:50 не называть просроченной задачу, срок которой истекает в 23:59; текст «Ещё не завершены к концу недели». Снимок отражает состояние на время отправки. Ссылки в SMS не содержат auth-токенов; открытие приложения требует авторизации.

Проверить свежесть индекса перед выборкой; при длительном сбое синхронизации отложить SMS в пределах допустимого окна или сообщить о невозможности составить актуальный список в приложении.

Номер и API SMS-шлюза — отдельные параметры, не ключ ИИ. Само mobile/PWA приложение не отправляет SMS через SIM. Выбор реального шлюза зависит от страны номера и его API; фиксировать адаптер после предоставления настроек, не обещать доставку без них.

Настройки: включение/отключение сортировки, дни/время, timezone, профиль сортировщика, папки-исключения, лимиты; отдельно включение SMS, номер, шлюз, время, maxItems, включение старых просроченных задач. При привязанном расписании SMS время обязано предшествовать воскресному запуску. Смена номера сбрасывает verifiedAt и приостанавливает SMS до новой проверки. Verification challenge имеет id, TTL, лимит попыток и частоты; подтвердить код либо подписанный callback согласно контракту выбранного шлюза.

Устойчивость:

- Scheduler работает на сервере при закрытом приложении и выключенном ПК.
- Хранит nextRunAt и jobs; lease продлевается владельцем. Проверка leaseOwner/fencingToken перед side effect не допускает запись старым worker после передачи lease. Для vault токен проверяется под общим lock; для SMS дополнительно нужен стабильный внешний idempotency key.
- Изменение времени/timezone не создаёт повтор уже выполненного occurrence. Пересчитать будущие jobs от момента изменения настроек, отменить устаревшие; ручной запуск имеет отдельный явный runId.
- После перезапуска пропущенные сортировки объединяются в один catch-up по checkpoint; не отправлять пачку устаревших SMS.
- SMS catch-up допустим в течение 30 минут и только до связанной воскресной сортировки; позже — skipped_missed_window. Отдельно показать пропуск в приложении.
- Недоставленная SMS не блокирует сортировку в 23:59. Повтор отправки ограничен и не вызывает повторную сортировку.
- После неизвестного результата send сначала запросить статус/использовать idempotency шлюза. При отсутствии этих возможностей не делать слепой повтор и не обещать exactly-once доставку.
- Retry 429/5xx/network выполняется с backoff и jitter; 401/403 и invalid phone требуют исправления настроек.
- Для DST: пропущенное локальное время — ближайшее существующее после него; повторённое — один запуск в первое вхождение. dedupeKey использует идентификатор локального occurrence. Moscow сейчас не требует переходов, но scheduler не должен зависеть от этого.
- Отключение отменяет queued jobs. Уже выполняющийся job проверяет enabled/version перед записью или отправкой; завершённое действие отменой настроек не откатывается.

**14. HTTP/WS API**

Все ниже, кроме health/pair, требуют app-авторизации. Управление секретами/SMS/расписанием — capability settings:manage у доверенных устройств владельца. Quick token имеет только notes:create в разрешённой папке.

| Метод и маршрут | Вход / результат |
|---|---|
| GET /api/providers | ProviderPublic[], лимиты chat=5/organizer=1 |
| POST /api/providers | slot + ProviderWrite → ProviderPublic |
| PATCH /api/providers/:id | ProviderWrite + version → ProviderPublic |
| DELETE /api/providers/:id | Версия, проверка зависимостей → результат удаления |
| POST /api/providers/:id/test | → ProviderTestResult |
| GET/PATCH /api/settings | Публичные настройки / типизированный patch с expectedVersion |
| GET/POST /api/chats | Пагинация / создать чат с mode, providerId, необязательным title |
| PATCH/DELETE /api/chats/:id | Изменить метаданные/привязку / удалить временные данные |
| GET /api/chats/:id/messages | cursor, limit → действующие сообщения и nextCursor |
| POST /api/chats/:id/messages | ChatSendRequest → 202 Accepted с requestId |
| GET /api/requests/:id | Состояние запроса и готовый результат для reconnect |
| POST /api/requests/:id/cancel | Идемпотентная отмена; уже записанный результат не исчезает |
| GET /api/commands?mode=note | Три доступные команды |
| POST /api/attachments | Поток multipart → Attachment |
| GET/DELETE /api/attachments/:id | Статус / удалить доступный временный файл |
| GET /api/attachments/:id/content | Авторизованная загрузка с безопасными headers |
| POST /api/attachments/:id/import | NoteInput + operationId → mutation/job receipt |
| GET /api/vault-assets/:id/content | Постоянный оригинал из vault по assetId, независимо от чата и временного upload |
| GET/POST /api/tasks | TaskQuery / TaskCreateInput + operationId |
| GET/PATCH /api/tasks/:id | Task / TaskPatch + expectedContentHash + operationId |
| GET/POST /api/notes | Поиск/список / NoteInput + operationId |
| GET/PATCH /api/notes/:id | Заметка / валидируемая правка + expectedContentHash |
| GET /api/organizer/runs | История запусков, checkpoint, pending, ошибки |
| POST /api/organizer/runs | Ручной запуск с idempotency key |
| GET /api/jobs/:id | Статус extraction/organization/import |
| POST /api/sms/verify | Запуск ограниченной проверки номера через выбранный шлюз |
| POST /api/sms/verify/confirm | verificationId + code → verifiedAt, с ограничением попыток |
| POST /api/ws-ticket | Короткоживущий одноразовый билет для WS |

WS: подписка на chatId/requestId с afterSequence, события ChatEvent. После разрыва — GET request + replay оставшихся событий, затем повтор с прежним requestId при необходимости. HTTP fallback использует тот же ключ, не запускает второй агент.

WS не передаёт долговечный токен устройства в URL. Одноразовый билет имеет короткий TTL, сервер проверяет Origin; переподключение получает новый билет. Отзыв устройства закрывает его соединения и запрещает новые операции.

Для POST/PATCH использовать Idempotency-Key либо requestId/operationId в общей схеме; выбрать один канонический механизм и проверять их равенство, если присланы оба. Конкурирующие запросы одного чата сериализуются или получают CHAT_BUSY; разные чаты могут читать параллельно, записи сериализует vault coordinator.

**15. Мобильный интерфейс**

- ИИ-чат: список чатов, новый/удалить/переименовать, текущая модель, переключатель «Задача / Заметка», поле текста, прикрепление фото/файла, slash-палитра, статус запроса.
- Уточнение дедлайна отображается как карточка draft с понятным вопросом и кратким составом задачи. При смене режима draft приостанавливается; ответ явно привязан к draftId.
- Для ответа показываются действия «Открыть задачу/заметку», источники и статус Git. Wikilinks должны открывать существующую заметку, а не быть только цветным текстом.
- Задачи: один набор данных и общие фильтры для списка, календаря и канбана. Изменение статуса в одном представлении обновляет остальные.
- Список сортируется по сроку/приоритету/категории/дате создания с устойчивым вторичным ключом id.
- Календарь: by_date — all-day, by_time — значок дедлайна, at_time — отметка конкретного времени. Показывать просроченность отдельно.
- Канбан: «К выполнению / В работе / Готово», cancelled через фильтр/архив. На телефоне кроме drag-and-drop есть меню смены статуса.
- «Добавить задачу»: заголовок, описание, категория, приоритет, тип срока, дата, время при необходимости, timezone, связанные заметки.
- «Добавить заметку»: тип, заголовок, текст, категория при необходимости, теги/keywords, предлагаемая папка, связанные заметки и вложения. Дедлайн у заметки не требуется.
- Настройки: пять chat-профилей, отдельный organizer, тест подключения, модель по умолчанию, расписание, SMS, timezone, статус Git, устройства.
- Offline: доступен ограниченный локальный черновик; нельзя показывать сохранение на сервере без подтверждения. После reconnect запрос отправляется с прежним operationId.
- Фото без текста — допустимый запрос после успешной загрузки. Нельзя смешивать результат старого чата с новым открытым чатом.
- Проверить клавиатуру, safe-area, скролл длинной истории, жесты, доступность подписей и контраст; жёлтый цвет не должен быть единственным обозначением режима.

**16. Таблицы и миграции**

Долговечная relay.sqlite:

- schema_migrations(version, appliedAt).
- workspaces(id, timezone, settingsVersion), devices(workspaceId, permissions, …).
- providers(id, workspaceId, slot, currentVersion); provider_versions(providerId, version, publicConfig, encryptedSecret, revokedAt).
- app_settings, organizer_settings, sms_settings с версионированием.
- note_index(id, path UNIQUE, hash, kind, metadata, parseState), task_index, note_links, asset_index.
- jobs(dedupeKey UNIQUE, state, attempt, leaseUntil, scheduledFor), outbox.
- vault_operations(operationId UNIQUE, draftId UNIQUE NULLABLE, requestHash, state, commitSha, errorCode).
- request_tombstones(workspaceId, requestId UNIQUE в workspace, fingerprint, operationIds, terminalStatus), без содержимого запросов.
- organizer_checkpoints, organizer_runs, organizer_items(noteId, inputHash, policyVersion, state).
- sms_deliveries(dedupeKey UNIQUE, providerMessageId, status); содержимое SMS хранить временно, не бессрочно в журнале.

Временная chat.sqlite:

- chats, messages с индексами (chatId, sequence) и expiresAt.
- requests с UNIQUE(workspaceId, requestId), версиями и expiresAt.
- chat_memory_facts, memory_sources, summary_segments.
- task_drafts, draft_sources.
- attachments, extraction_chunks, attachment_refs.
- stream_events(requestId, sequence), срок не длиннее истории.

Каждая ссылка проверяет workspaceId; SQL foreign keys включены. Chat metadata, provider binding и request snapshots версионируются. Из-за двух БД очищение/создание ресурсов между ними выполняется идемпотентными jobs, не мнимой общей транзакцией.

Переход:

1. Сделать резервную копию vault и durable DB; зафиксировать Git head. Для старой БД с чатами установить ограниченный срок backup и удалить его после проверки миграции.
2. Старый ENV LLM_* импортировать ровно один раз в chat-profile «Основной». После миграции ENV не должен перезаписывать пользовательские настройки.
3. Для прежних deviceId + chat создать отдельные чаты «Импорт: устройство / chat», привязать к одному workspace. Не объединять разные разговоры по строке main.
4. Перенести только сообщения моложе 14 дней. Старые записи и их копии очистить, до очистки не заявлять новую retention-гарантию.
5. Добавить устойчивые IDs управляемым заметкам при изменении/контролируемой миграции; внешние файлы без IDs сначала индексировать через path/hash.
6. Checkboxes импортировать read-only как legacy, конвертировать по мере ввода обязательных полей. Не присваивать выдуманный дедлайн всем старым задачам.
7. Сначала построить индекс и показать dry-run первой сортировки. Автоматическое расписание включается только после проверки конфигурации.
8. При rollback приложения сохранять новые .md и новые поля; старый writer не включать, если он может повредить новую схему. Откат файлов — отдельный Git revert с проверкой последующих изменений.

**17. Критические ошибки и обработка**

| Ситуация | Поведение |
|---|---|
| Шестой chat-профиль, в том числе при двух одновременных POST | 409 PROVIDER_LIMIT, транзакционный счётчик |
| Нет ключа, 401/403 LLM, неверная модель | PROVIDER_AUTH / MODEL_UNAVAILABLE; без бессмысленных retries |
| 429, timeout, 5xx | Ограниченный retry/backoff, отсутствие повторной записи благодаря operationId |
| Модель не поддерживает изображения/tools | CAPABILITY_UNSUPPORTED; предложить другой профиль или доступный OCR |
| Нет срока или он неоднозначен | needs_input + draft; задача не попадает в Git/активный список |
| Недопустимая дата, DST, год не указан, срок в прошлом | Полевая ошибка/уточнение, никаких молчаливых сдвигов |
| Повтор reply к уже завершённому draft | Вернуть существующий receipt либо DRAFT_CONFLICT |
| Чат/режим/модель сменились во время ответа | Результат относится к исходным chatId/requestId/binding |
| Сообщение истекло во время LLM-запроса | Перед выдачей/мутацией повторно проверить источники; остановить зависимую операцию |
| Рестарт после файла/commit, но до ответа | Recovery + journal + Git trailer; не создавать второй файл |
| Редактирование той же задачи в Obsidian и PWA | 409 VERSION_CONFLICT, сохранить обе версии для разрешения |
| Git push отклонён | Локальный результат остаётся, sync pending/conflict; без force push |
| Force-push удалил checkpoint | Reconciliation, не продвижение пустого checkpoint |
| Rename, одинаковые имена, Windows case-insensitive paths | Стабильные IDs, casefold/collision проверки; неоднозначный move отложить |
| Symlink, ../, абсолютный путь, Private/.git/.obsidian | FORBIDDEN_PATH; realpath и проверка каждого сегмента |
| Невалидный YAML/повтор relay_id | Изолировать запись в index errors, не перезаписывать исходник |
| Файл повреждён/защищён/слишком велик | Конкретный 413/415/422 с сохранением допустимого пользовательского черновика |
| OCR частичен | partial + перечень пропусков; нельзя заявлять полный перенос |
| Истёк временный файл в очереди | ATTACHMENT_EXPIRED; не продлевать TTL из-за retry |
| Нет кандидатов для связей | Сохранить заметку с keywords без придуманных ссылок |
| Тёзки в /person | Выбор кандидата, не автоматическое слияние |
| Инструкция внутри PDF/.md «раскрой ключи/удали файлы» | Рассматривать как данные; allowlist и валидатор блокируют действие |
| Настройки выключили job между планом и записью | Проверить версию перед side effect, отменить неисполненную часть |
| SMS ответ неизвестен | Сверить статус, не делать слепую повторную отправку |
| Диск заполнен/commit не создан | Ошибка мутации с recovery; не показывать «Сохранено» до устойчивой записи |
| Индекс повреждён/отстаёт | Перестроить из Git/vault, показать обновление; не затирать канонические файлы |

Общие коды: UNAUTHORIZED, FORBIDDEN, VALIDATION_ERROR, NOT_FOUND, CONFLICT, RATE_LIMITED, STORAGE_UNAVAILABLE, CANCELLED. Не отправлять клиенту stack traces, секреты, абсолютные системные пути или полный upstream response.

**18. Пошаговый чеклист внедрения для разработчика**

Этапы выполнять в порядке зависимостей. Для каждого: изменения → значимые проверки → короткий отчёт → следующий этап. Не выполнять массовые операции на реальном vault во время разработки.

**Этап 0. Базовая проверка и стенд**

- [ ] Прочитать repository instructions, проверить git status, существующие команды и фактический Node runtime.
- [ ] Зафиксировать текущее поведение typecheck/build/test. Учесть расхождение engines >=20 и использования node:sqlite; согласовать runtime с Docker.
- [ ] Создать тестовый vault: обычные заметки, люди-тёзки, private folder, YAML, wikilinks, legacy checkboxes, rename, PDF и изображения.
- [ ] Подготовить локальный bare Git remote и два clone для конфликтов; fake clock, fake LLM/SMS adapters.
- [ ] Зафиксировать контракты и критерии ниже до разнесения реализации между агентами.

**Этап 1. Общие типы и схемы**

- [ ] Добавить contracts/* в core либо отдельный browser-safe shared entrypoint; app не должен импортировать fs/node:sqlite транзитивно.
- [ ] Ввести runtime schemas для DTO, Deadline, Task, Note, Provider, события WS, errors.
- [ ] Реализовать сериализацию metadata, стабильные IDs, версии и происхождение inferred полей.
- [ ] Проверить round-trip Markdown/YAML с неизвестными полями, Unicode, переносами строк.
- [ ] Зафиксировать enum-to-label mapping и priority ordering.

**Этап 2. Хранение и migrations**

- [ ] Выделить durable relay.sqlite и transient chat.sqlite; создать versioned migrations и индексы.
- [ ] Добавить workspace ownership к устройствам, scopes и FK.
- [ ] Мигрировать только действующую историю; отдельный импортный чат на прежнюю пару device/chat.
- [ ] Ввести request/operation idempotency, optimistic concurrency и журнал.
- [ ] Добавить durable tombstones и уникальную reservation по draftId; проверить retry после удаления истории.
- [ ] Проверить повторный запуск миграции и прерывание между шагами.

**Этап 3. Координатор vault/Git**

- [ ] Реализовать VaultMutationService, общую очередь записи, staging, recovery.
- [ ] Перевести существующие create/append/quick endpoints на координатор.
- [ ] Разделить saved_local/committed/synced, добавить устойчивый push outbox.
- [ ] Добавить safe path/realpath/ignore checks и явный набор Git paths.
- [ ] Проверить сбои в каждой фазе, конфликт двух устройств и remote ahead.

**Этап 4. Провайдеры**

- [ ] Ввести ProviderRegistry, шифрование ключей, write-only secret DTO и одноразовый ENV import.
- [ ] Реализовать 5 chat slots + 1 organizer, default/chat binding и version snapshots.
- [ ] Выделить OpenAI-compatible adapter; добавить другие native adapters только с их отдельными схемами/тестами.
- [ ] Добавить endpoint test, capability validation, лимиты, таймауты, SSRF allowlist.
- [ ] Сделать настройки создания/изменения/удаления/теста и понятные ошибки.

**Этап 5. Заметки и индекс**

- [ ] Создать metadata parser, NoteService, поиск keywords/tags/aliases, индекс ссылок.
- [ ] Ввести folder rules, locked fields, note IDs, related-note ranking.
- [ ] Реализовать /quick, /idea, /person через единый pipeline enrichment.
- [ ] Добавить безопасное редактирование по hash и выбор человека при неоднозначности.
- [ ] Обеспечить открытие wikilinks и просмотр заметок в PWA.

**Этап 6. Задачи и режимы агента**

- [ ] Реализовать Deadline parser/validator с referenceInstant и timezone.
- [ ] Добавить TaskDraft → needs_input → ready → committed, версионирование draft.
- [ ] Проверить две разные реплики к одному draft и «до завтра» в уточнении на следующий день.
- [ ] TaskService.create/update должен одинаково проверять AI/manual/REST/WS.
- [ ] Удалить обход через старые /task и append_daily(as_task); создать совместимый маршрут через TaskService либо вернуть подсказку смены режима.
- [ ] Добавить task projection, legacy records и безопасную конвертацию.
- [ ] Разделить ModePolicy, system prompts и allowlists; ограничить пользовательские сценарии.

**Этап 7. Чаты и память**

- [ ] CRUD чатов, серверная история, привязки моделей, pagination и request snapshots.
- [ ] Correlation requestId/chatId/sequence на REST/WS, replay и восстановление после разрыва.
- [ ] ContextBuilder с бюджетом, summary segments, facts lineage, invalidation по note hash.
- [ ] TTL фильтры, purge, временные файлы, очистка provider uploads, отсутствие content logs.
- [ ] Настроить backups/WAL/browser cache так, чтобы не обходить retention.
- [ ] Проверить fake-clock границы 14 дней, активный чат со старыми фактами и restart cleanup.

**Этап 8. Вложения**

- [ ] Upload streams, квоты, MIME verification, auth download, временное хранение.
- [ ] Extractor/OCR workers с состояниями и ограничением ресурсов.
- [ ] Context pipeline и отдельный full-note pipeline.
- [ ] Manifest покрытия, оригинал в Git, полный текст/части, повторная обработка ошибок.
- [ ] Постоянный VaultAsset остаётся доступен после удаления чата/истечения upload ID.
- [ ] UI progress/partial/errors, фото без текста, истечение attachment, недоступный vision.

**Этап 9. Две рабочие области**

- [ ] AppShell, tabs Chat/Tasks, сохранение выбранного чата и фильтров.
- [ ] ChatList, MessageList, Composer, ModeSelector, SlashPalette и AttachmentPicker.
- [ ] Список задач и ручная форма задачи.
- [ ] Календарь с корректными Deadline kinds.
- [ ] Канбан и доступное меню смены статуса.
- [ ] Ручная заметка из области задач; обновление всех представлений от одного query state.
- [ ] Проверить touch, клавиатуру, safe-area, reconnect, offline draft и смену чата в полёте.

**Этап 10. Сортировка**

- [ ] Устойчивые jobs, lease/dedupe, clock/timezone, settings version и catch-up.
- [ ] Fencing старого worker и защита от повтора occurrence при смене расписания.
- [ ] Первичный snapshot/index, Git diff checkpoint, rename/delete handling.
- [ ] LLM planner со строгим OrganizationPlan и бюджетом.
- [ ] Валидатор, deterministic link repair, CAS перед записью.
- [ ] Chunk continuation, processed-hash cache, pending queue, checkpoint только после успеха.
- [ ] Экран запуска/ошибок/изменений; настройки расписания и отдельного профиля.
- [ ] Проверить повтор без semantic diff, concurrent user write, history rewrite и падение push.

**Этап 11. SMS**

- [ ] Выбрать и реализовать один реальный SmsAdapter после определения доступного шлюза.
- [ ] Добавить секреты шлюза, verified E.164, opt-in и отмену.
- [ ] WeeklyDigest query, локальная неделя, top five, ограничение сегментов.
- [ ] Расписание перед воскресной сортировкой, delivery status, dedupe, unknown-send handling.
- [ ] Проверить пустой список, задачу выполненную перед отправкой, delayed job и SMS failure при успешной сортировке.

**Этап 12. Удаление голоса**

- [ ] Удалить MediaRecorder/getUserMedia, refs/state/toggleRecord и mic button из Chat.tsx.
- [ ] Удалить api.transcribe, POST /api/transcribe, LlmClient.transcribe.
- [ ] Удалить whisperModel, WHISPER_MODEL, audio parsers, связанные CSS/документацию.
- [ ] Сохранить общие upload-примитивы, если они нужны документам; аудио как формат в первом релизе не принимать.
- [ ] Проверить отсутствие запросов разрешения микрофона и недоступность старого endpoint.

**Этап 13. Приёмка и rollout**

- [ ] Расширить корневые scripts так, чтобы проверки включали server и app, а не только core.
- [ ] Выполнить typecheck, build, core/server integration и критические E2E.
- [ ] На копии vault прогнать миграцию → создание → sync → edit в Obsidian → reindex → сортировку → recovery.
- [ ] Сверить diff: сохранность текста, незатронутые private folders, рабочие ссылки, отсутствие ключей/истории/uploads в Git.
- [ ] Проверить выключенный ПК/закрытую PWA, рестарт worker и fake-clock среду/воскресенье.
- [ ] Обновить README, .env.example, deployment secrets, backup/retention policy и руководство восстановления.
- [ ] Включать функции поэтапно: providers/notes/tasks → chats/memory → attachments → organizer → SMS.
- [ ] Первую сортировку реального vault включить после просмотра dry-run; SMS — после настройки и проверки номера.

Рекомендуемое разбиение по файлам:

| Пакет | Модули |
|---|---|
| core | contracts/, domain/tasks.ts, domain/deadlines.ts, domain/notes.ts, metadata/, agent/modes/, providers/, indexing/, organization/ |
| server | routes/, services/chat.ts, services/context.ts, services/attachments.ts, services/retention.ts, services/vault-mutations.ts, storage/migrations/, jobs/, sms/, secrets.ts |
| app | screens/Tasks.tsx, screens/Chats.tsx, components/chat/, components/tasks/, components/settings/, query/, api/ |

Не создавать пустой «каркас всех файлов» отдельным этапом. Внедрять законченные вертикальные цепочки с работающим API и UI.

**19. Обязательные приёмочные сценарии**

| Сценарий | Ожидаемый результат |
|---|---|
| «Подготовить отчёт» → «до завтра» | Уточнение; затем ровно одна задача с датой, категорией и приоритетом |
| «Позвонить в понедельник в 15:00» | at_time в Moscow, конкретная дата после корректного разрешения неоднозначностей |
| Ручной POST задачи без срока | 422, записи в vault нет |
| Пятый chat-профиль + organizer | Допустимо; шестой chat-профиль — отказ |
| Switch provider в существующем чате | История сохраняется, следующий запрос идёт выбранному провайдеру |
| /person при двух Александарах | Выбор пользователя, ни одна карточка не повреждена |
| /quick при недоступном LLM | Исходный текст сохранён, enrichment pending, есть минимальные keywords |
| 30-страничный PDF, 2 страницы не распознаны | Оригинал сохранён, partial и конкретные страницы, без заявления полного переноса |
| Успешный полный импорт | Manifest покрывает все части; весь извлечённый текст и оригинал доступны в Git |
| Разрыв WS после записи | Reconnect показывает прежний результат, второй файл не создаётся |
| Два разных requestId отвечают на один draft | Одна созданная задача по уникальному draftId |
| Retry старого requestId после 14 дней | Существующий artifact или REQUEST_EXPIRED, без повторной записи |
| Активный чат старше 14 дней | Старых сообщений и зависимых facts нет; новые доступны |
| История удалена | Созданная ранее задача/заметка остаётся в Git и списках |
| Удалён чат полного импорта | Оригинал открывается по постоянному assetId, без временного Attachment |
| Завершение задачи в канбане | Список и календарь отражают то же состояние |
| Среда/воскресенье 23:59 при закрытой PWA | Один запуск серверного job |
| Сортировка без изменений после предыдущей | Ноль повторных LLM-анализов неизменившихся заметок |
| Новая заметка создана во время сортировки | Не теряется за checkpoint; либо replan, либо следующий корректный запуск |
| Rename заметки со ссылками/embeds | Все однозначные ссылки сохранены; неоднозначный перенос отложен |
| SMS перед воскресной сортировкой | Короткий актуальный список, один логический запрос отправки |
| SMS шлюз недоступен | Ошибка видна; сортировка выполняется по расписанию |
| Отключение schedule | Будущие jobs не создаются/отменены, ожидающие side effects не выполняются |
| Голос удалён | Нет кнопки, permission запроса, transcription route/config |

**20. Готовое задание для GPT‑6.1 Sol High**

Можно передать модели следующую инструкцию вместе с этим файлом:

> Реализуй изменения Obsidian Relay по docs/mobile-v2-architecture-and-plan.ru.md. Работай в существующем TypeScript monorepo и сохраняй совместимость существующих данных. Лимит подтверждён: пять профилей чата плюс отдельный профиль сортировщика со своим API-ключом. Следуй этапам 0–13; не обходи зависимости и не подменяй недоступный сервис фиктивным результатом.
>
> Перед изменениями проверь инструкции репозитория, git status и baseline проверок. Начни с общих контрактов, миграций и единого механизма записи vault/Git; затем реализуй вертикальные сценарии. Для независимых модулей можно использовать агентов после фиксации DTO, но один исполнитель владеет миграциями и координатором записи.
>
> Ключевые инварианты: нет новой задачи без явного дедлайна; одна операция не создаёт дубликаты после retry; Markdown/Git — источник истины для результатов; история и производная память не обходят TTL 14 дней; Git checkpoint не пропускает параллельные изменения; sorter использует отдельный профиль; ключи не возвращаются клиенту; полный импорт не сводится к summary.
>
> Не выполняй массовую сортировку реального vault и не отправляй реальные SMS для тестирования. Используй копию vault и fake adapters. Если production API-ключ/номер/шлюз отсутствует, реализуй интеграционный контракт и UI ошибки, явно укажи, что внешняя проверка ещё требуется.
>
> После каждого этапа выполняй подходящие проверки. В финале перечисли готовые пользовательские сценарии, результаты проверок, изменения миграции/deployment и оставшиеся внешние зависимости. Не объявляй реализацию завершённой, пока обязательные критерии приёмки не проверены или конкретно не отмечены как заблокированные внешними настройками.
