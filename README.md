# Obsidian Relay

Ваше хранилище Obsidian — с телефона, из браузера, **даже когда компьютер выключен**.

Отличие от Elton AI: сервер здесь не «почтальон», а отвечающий. Он держит копию хранилища (через git),
сам ищет и читает заметки, создаёт новые и вызывает модель. ПК с Obsidian — лишь ещё один участник
синхронизации: включён — изменения разъезжаются за минуту; выключен — сервер работает один.

```
Телефон (PWA) ──HTTPS/WSS──► Сервер (VPS, Docker)
                              ├─ Fastify: код → ключ устройства, чат (WebSocket), REST
                              ├─ Агент: search/read/create + OpenAI-совместимая модель
                              └─ /data/vault ◄── git pull/push ──► git-remote ◄── obsidian-git ── ПК
```

Что умеет: записать мысль, добавить строку/задачу в ежедневную заметку, ответить по заметкам,
показать заметку, 20 слэш-команд + ваши сценарии, голос (Whisper), кнопка быстрой записи с локскрина,
несколько устройств с отзывом.

Честная цена: **нет сквозного шифрования** — сервер видит заметки, иначе он не смог бы отвечать без ПК.
Личные папки (`Private/`, `Journal/`…) исключаются из git и никогда не покидают ПК.

## Структура

```
packages/core     ядро: адаптер хранилища поверх ФС, поиск, шаблоны, инструменты, агент, команды
packages/server   Fastify + WebSocket + SQLite (node:sqlite), git-синхронизация, CLI
packages/app      PWA (React + Vite + vite-plugin-pwa)
deploy/           Dockerfile, docker-compose (Caddy + relay), пример .gitignore для хранилища
```

## 1. Хранилище → git

1. На ПК в корне хранилища сделайте git-репозиторий и добавьте `.gitignore` (пример: `deploy/vault.gitignore.example`).
   Личные папки перечислите там же — они не попадут на сервер.
2. Создайте **приватный** репозиторий (GitHub/GitLab/Gitea или голый репо на самом VPS) и запушьте.
3. В Obsidian поставьте плагин **Git** (obsidian-git). Настройки: auto commit-and-sync каждые 5–10 минут,
   auto pull при открытии, «Pull updates on startup». Всё — теперь ПК сам коммитит и тянет.

## 2. Сервер (VPS)

Нужны: Ubuntu с Docker, домен, указывающий на VPS, ключ OpenRouter/OpenAI (или Ollama на VPS).

```bash
git clone <этот репозиторий> obsidian-relay && cd obsidian-relay
cp .env.example .env            # заполните DOMAIN, PUBLIC_URL, LLM_*, GIT_REMOTE, VAULT_*
mkdir -p deploy/ssh && ssh-keygen -t ed25519 -f deploy/ssh/id_ed25519 -N ""
cat deploy/ssh/id_ed25519.pub   # добавьте как Deploy key с правом записи в репо хранилища
ssh-keyscan github.com > deploy/ssh/known_hosts
cd deploy && docker compose up -d --build
docker compose logs -f relay    # в логе появится первый код подключения
```

Сервер сам склонирует хранилище в `/data/vault`, тянет изменения раз в `SYNC_PULL_INTERVAL` секунд
и перед каждым ответом, а после записи с телефона коммитит и пушит.

Управление:

```bash
docker compose exec relay node packages/server/dist/cli.js code        # новый код подключения
docker compose exec relay node packages/server/dist/cli.js devices     # устройства
docker compose exec relay node packages/server/dist/cli.js revoke 3    # отключить
docker compose exec relay node packages/server/dist/cli.js reset       # отключить все
docker compose exec relay node packages/server/dist/cli.js quick-key   # ключ для кнопки
```

## 3. Телефон

1. Откройте `https://<DOMAIN>` в браузере телефона и **добавьте на домашний экран**
   (iPhone: Поделиться → «На экран Домой»; Android: меню → «Установить приложение»).
   Из обычной вкладки вход закрыт — как в оригинале (`REQUIRE_STANDALONE=false` отключает это для разработки).
2. Откройте с иконки, введите код подключения. Код одноразовый: телефон получает свой ключ.
3. Пишите. `/` открывает список команд. Настройки → устройства, новый код, ключ быстрой записи.

### Кнопка быстрой записи (iOS Команды / Android HTTP Shortcuts)

Создайте ключ в Настройках (или `cli quick-key`). Запрос:
`POST https://<DOMAIN>/api/send`, заголовок `content-type: application/json`,
тело `{"token": "<ключ>", "text": "<текст>", "chat": "quick"}` (`"chat": "daily"` — строкой в сегодняшний день).
Ключ умеет только создавать заметку; код подключения в нём не работает.

На Android приложение само появляется в меню «Поделиться» (share target).

## Локальная разработка

```bash
npm install
npm run build
npm test                                  # тесты core
# .env в корне: VAULT_PATH=<путь к копии хранилища>, LLM_*, SYNC_MODE=none, REQUIRE_STANDALONE=false
npm run dev:server                        # http://localhost:8080 (отдаёт собранную PWA)
npm run dev:app                           # vite на :5173 с прокси /api
```

Требуется Node 22.13+ (используется встроенный `node:sqlite` без флагов). Для `SYNC_MODE=git` нужен `git` в PATH.

## Настройка агента

`data/scenarios.json` (путь — `SCENARIOS_FILE`):

```json
{
  "systemPrompt": "Пиши коротко. Ссылки на заметки оформляй как [[wikilinks]].",
  "scenarios": {
    "план": "Прочитай сегодняшнюю заметку и составь план дня из 3 пунктов.",
    "ретро": "По ежедневным заметкам за неделю напиши ретроспективу: что получилось, что нет, что менять."
  }
}
```

Сценарии появляются в слэш-меню первыми: `/план`, `/ретро`.

## Что дальше (после MVP)

- Смысловой поиск (эмбеддинги) вместо ключевых слов
- Фото конспекта → заметка (vision-модель)
- Push-уведомления о долгих ответах
- Форк плагина Elton AI с выгрузкой настроек (шаблоны, личные папки, сценарии) на сервер
- Бэкапы `/data` (restic)
