# 01. M1 — Скелет

> Этап: M1 · Оценка: 1–2 дня · Зависит от: — · Разблокирует: M2, M3
> Владелец: writer-core

## 1. Цель и границы

Этап создаёт минимальный, но полностью рабочий каркас приложения: Electron-оболочку с окном, sidecar-бэкенд на FastAPI, рукопожатие по токену и динамическому порту, пустую БД с раннером миграций, каркас SSE и API настроек, dev-скрипты, логирование и базовые тесты. После M1 приложение запускается, показывает скелет интерфейса и сообщает о готовности бэкенда; пользовательских функций (библиотека, транскрипция, поиск, плеер) ещё нет.

**Входит в этап:**
- Electron main: окно 1400×900 (min 1024×700), CSP, single-instance, запрет навигации и `window.open`.
- Sidecar: спавн бэкенда, handshake `VL_TOKEN` / `VL_READY`, динамический порт `127.0.0.1:0`, health-check, рестарт с backoff.
- Backend: `create_app()`, конфиг, подключение к SQLite (WAL), раннер миграций по `PRAGMA user_version`, `/api/health`, auth-middleware, статика SPA, SSE-каркас `/api/events`, `/api/settings`.
- Preload + `contextBridge` → `window.vl` по контракту `00-conventions.md` §6, IPC-хендлеры, типизированный frontend-клиент.
- Frontend-каркас: Vite + React + TS, layout-заглушка по `TARGET.md` §2, индикатор состояния бэкенда, `useSSE`, `i18n/ru.json`, `lib/time.ts`.
- Dev-скрипты (`scripts/dev.sh`, `npm run dev`), логирование (backend и Electron), Playwright e2e-smoke.
- Пустая БД: базовые таблицы `TARGET.md` §4 (создаются сразу, чтобы M6/M7 не вводили миграции с меньшими номерами), плюс обязательная дельта `00-conventions.md` §5.

**Не входит (границы):**
- Сканирование, ffprobe, watched folders, список файлов — M2.
- Транскрипция, очередь, cancelled/reprocess — M3.
- FTS-поиск — M4; плеер, стриминг и тайминги — M5; теги — M6; метки — M7.
- PyInstaller, ffmpeg/ffprobe и модель в `extraResources`, `.deb`/`.AppImage` — M8.
- Полный settings-диалог, темы, горячие клавиши, ротация UI-логов — M9.
- Реальный источник данных для вкладок «Файлы»/«Теги»; вкладки отрисовываются как заглушки.

## 2. Предусловия

- Прочитаны `../TARGET.md` (разделы §1, §2, §4, §5, §6, §8, §9) и `./00-conventions.md` (ADR A1–A6, A12–A14, §4–§7, §10).
- Инструменты на dev-машине: Node.js ≥ 20, npm, Python 3.11, `ruff`, `git`. Electron 31+ ставится как devDependency.
- Свободны порты `5173` (Vite) и `8765` (dev-бэкенд); в prod порт выбирается динамически.
- Каталог данных не требует очистки: раннер миграций создаёт БД при первом запуске.
- Ресурсы `ffmpeg`/`ffprobe` и модель не нужны — они появляются в M2/M3/M8.
- Репозиторий пуст либо содержит только `TARGET.md`, `PLAN.md` и `plans/`; корень проекта — текущая рабочая директория.

## 3. Решения

**D-01.1. Режимы загрузки renderer.** В prod окно грузит `http://127.0.0.1:<port>/` (SPA отдаёт бэкенд, A1); в dev — `http://localhost:5173/` с прокси `/api` → `http://127.0.0.1:8765`. Ветвление по `app.isPackaged` в `electron/main.ts`. Это единственное место, где различаются dev/prod окружения.

**D-01.2. Сборка Electron-части.** `main`/`preload` собираются `esbuild` в `dist-electron/` (по одному бандлу, CJS для main и preload), renderer — Vite. Отказываемся от `electron-vite`/`vite-plugin-electron`: нужен явный контроль над CSP, `sandbox: true` и путями preload; лишний слой усложняет отладку handshake.

**D-01.3. CSP.** Заголовок `Content-Security-Policy` выставляется в `session.defaultSession.webRequest.onHeadersReceived`, чтобы одинаково работать для dev и prod и не зависеть от статики. Prod: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Dev: дополнительно разрешены `http://localhost:5173`, `ws://localhost:5173` и `'unsafe-inline'` для стилей/скриптов Vite HMR. `'unsafe-eval'` не включается ни в каком режиме.

**D-01.4. Контракт запуска sidecar.** Electron генерирует `VL_TOKEN` (`crypto.randomBytes(32).toString('hex')`, 64 hex-символа) и передаёт в env `VL_TOKEN`, `VL_DATA_DIR`, `VL_RESOURCES_DIR`; в dev дополнительно `VL_DEV_BACKEND_PORT=8765`. Порт: бэкенд сам биндит `127.0.0.1:0` (prod), печатает в stdout ровно одну строку `VL_READY:{"port":<n>}` сразу после `bind()` и только затем запускает uvicorn (порт известен до старта приложения). Electron читает stdout построчно и после `VL_READY` опрашивает `/api/health` до 15 с. В dev бэкенд запускает `scripts/dev.sh`, а не Electron (`getBackend()` возвращает `http://127.0.0.1:8765`), чтобы HMR-цикл не перезапускал Python-процесс.

**D-01.5. Наблюдение за sidecar и рестарт.** Health-опрос из main раз в 5 с с токеном. 3 подряд неуспешных ответа или неожиданный `exit` → статус `crashed` в renderer, до 3 перезапусков с backoff 1/2/4 с. После третьей неудачи — экран ошибки с кнопкой ручного перезапуска; авто-рестарты прекращаются. Штатное завершение: `SIGTERM`, ожидание ≤ 3 с, затем `SIGKILL`; `before-quit` ждёт остановки, чтобы не оставить сироту (вклад в критерий `TARGET.md` §7 п.9).

**D-01.6. Миграции.** Forward-only раннер: файлы `backend/app/migrations/NNN_*.sql` применяются по возрастанию номера, каждый — в отдельной транзакции с записью `PRAGMA user_version = NNN`. В M1 создаются `001_init.sql` (базовые таблицы `TARGET.md` §4 без FTS: FTS — M4), `002_video_meta.sql` (колонки `lang`, `model`, `headline`) и `003_settings_fs.sql` (`settings`, `folder_stats`), чтобы M2/M3/M4 не вводили миграций с меньшими номерами. Колонки 002 в M1 не используются — это резерв контракта `00-conventions.md` §5.

**D-01.7. Авторизация.** Middleware проверяет `X-VL-Token` на всех `/api/*` (включая `/api/health`), для `/api/events` допускает `?token=` (ограничение `EventSource`, A4). Сравнение — `hmac.compare_digest`, ответ `401 {"detail":"unauthorized"}`. Токен никогда не пишется в логи и не попадает в текст ошибок.

**D-01.8. SSE-каркас.** `sse-starlette.EventSourceResponse` с heartbeat 15 с и единый `EventBus` (набор `asyncio.Queue` подписчиков). В M1 генерируются только `settings.changed` и `backend.error`; конверт события — см. §4 (новый контракт). Подписчик удаляется при разрыве соединения, очередь ограничена (drop старых событий для медленных клиентов).

**D-01.9. `/api/settings`.** Хранилище — таблица `settings(key, value)` (A12), значения — JSON-строки. Форма и ключи ратифицированы в `./00-conventions.md` §4.1 п.1: `GET → {"language":"auto","whisper_model":"small","theme":"system","tags.multi_select_mode":"union","tags.max_depth":5,"log.level":"INFO"}`; `PATCH` — частичный объект, ответ — полный объект; ошибки `400 unknown_setting`/`400 invalid_setting`. В M1 активны ключи `language` (`auto/ru/en`, дефолт `auto`), `whisper_model` (`tiny/base/small/medium`, дефолт `small`), `theme` (`light/dark/system`, дефолт `system`) — потребители M3/M9; namespaced-ключи M6/M9 добавляются позже. После PATCH публикуется `settings.changed {keys:[…]}`.

**D-01.10. Логирование.** `utils/logging.py`: RotatingFileHandler `$VL_DATA_DIR/logs/backend.log` (10 МБ × 5, INFO) + stderr для dev; uvicorn-логи направляются в тот же файл. Electron ведёт `logs/electron.log` (простая ротация при старте: 10 МБ → `.1`), ошибки renderer приходят через IPC `vl:log`. Формат строки: `ISO-8601 UTC | LEVEL | logger | message`.

## 4. Изменения контрактов

### 4.1. API

| Метод | Путь | Статус | Что фиксирует этап |
|---|---|---|---|
| GET | `/api/health` | контракт `00` §4 | `200 {"status":"ok","version":"0.1.0","db":"ok"}`; при недоступной БД — `503 {"status":"degraded","db":"error"}` (уточнение кода ответа) |
| GET | `/api/events` | конверт — контракт `00` A5 | SSE, авторизация `?token=`; heartbeat 15 с; события `settings.changed`, `backend.error` |
| GET | `/api/settings` | контракт `00` §4.1 п.1 | плоский объект: `{"language":"auto","whisper_model":"small","theme":"system","tags.multi_select_mode":"union","tags.max_depth":5,"log.level":"INFO"}` |
| PATCH | `/api/settings` | контракт `00` §4.1 п.1 | частичный объект, напр. `{"language":"ru"}` → `200` полный объект; `400 unknown_setting` / `400 invalid_setting`; SSE `settings.changed {keys:["language"]}` |
| GET | `/` и SPA-маршруты | A1 | статика `frontend/dist`, fallback на `index.html` для путей без `/api`; при отсутствии сборки — `503` с подсказкой |

Конверт SSE (общий для всех этапов), **контракт `00` A5**: 

```text
event: settings.changed
data: {"type":"settings.changed","ts":"2026-10-26T17:00:00Z","payload":{"keys":["language"]}}
```

### 4.2. БД (миграции M1)

| Миграция | Содержимое | Источник |
|---|---|---|
| `001_init.sql` | `videos`, `segments` (+`idx_seg_video_time`), `tags`, `video_tags`, `annotations` (+`idx_ann_video`), `segment_tags`, `watched_folders` | `TARGET.md` §4 |
| `002_video_meta.sql` | `ALTER TABLE videos ADD COLUMN lang/model/headline` | `00` §5 (002) |
| `003_settings_fs.sql` | `settings(key,value)`, `folder_stats(folder_path,total,done,updated_at)` | `00` §5 (003) |

PRAGMA на каждом соединении: `foreign_keys=ON`; при инициализации БД: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=30000` (A7). FTS5, `segments_fts`, `annotations_fts`, `annotation_tags` в M1 не создаются.

### 4.3. Electron ↔ Renderer (только каналы из `00` §6)

| Канал | Тип | Метод `window.vl` |
|---|---|---|
| `vl:backend:get` | invoke | `getBackend()` |
| `vl:dialog:open-files` | invoke | `openFiles()` (фильтры видео по `TARGET.md` §3.1) |
| `vl:dialog:open-folder` | invoke | `openFolder()` |
| `vl:shell:reveal` | invoke | `revealInExplorer(path)` |
| `vl:shell:open-external` | invoke | `openExternal(url)` (только http/https) |
| `vl:app:info` | invoke | `getAppInfo()` |
| `vl:log` | send | `log(level,msg)` |
| `vl:backend:status` | main → renderer | `onBackendStatus(cb)` |

Правило §6 «`window.vl` только через слой `api/*`» ратифицировано в `00` §4.1 п.7: добавляется тонкая обёртка `frontend/src/api/electron.ts`; прямой вызов `window.vl` из компонентов запрещён.

### 4.4. Переменные окружения и пути

| Имя | Этап | Назначение |
|---|---|---|
| `VL_TOKEN` | M1 | 64 hex, авторизация `/api/*` |
| `VL_DATA_DIR` | M1 | `${XDG_DATA_HOME:-~/.local/share}/VideoLessons` |
| `VL_RESOURCES_DIR` | M1 | в dev — `./resources`, в prod — `process.resourcesPath` (используется с M2) |
| `VL_DEV_BACKEND_PORT` | M1 | `8765`, только dev |
| `VL_FRONTEND_DIR` | M1 | путь к `frontend/dist` для статики; по умолчанию `<VL_RESOURCES_DIR>/frontend/dist` (prod) и `<repo>/frontend/dist` (dev) — **контракт `00` §7** |

## 5. Задачи

### T-01.1. Каркас репозитория, toolchain и dev-скрипты
**Файлы:** `package.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `backend/pyproject.toml`, `scripts/dev.sh`, `scripts/test.sh`, `README.md`, `electron/tsconfig.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `playwright.config.ts`.
**Что сделать:**
1. Завести единый `package.json` (без workspaces): devDependencies — `electron`, `vite`, `typescript`, `esbuild`, `react`, `react-dom`, `@types/*`, `concurrently`, `wait-on`, `@playwright/test`, `vitest`.
2. `backend/pyproject.toml`: зависимости `fastapi`, `uvicorn[standard]`, `sse-starlette`, `pydantic`; dev — `pytest`, `pytest-asyncio`, `httpx`, `ruff`; `ruff` с line-length 100.
3. `.gitignore`: `node_modules/`, `dist/`, `dist-electron/`, `.venv/`, `resources/ffmpeg/`, `resources/models/`, `*.db`, `logs/`, `test-results/`, `playwright-report/`.
4. `scripts/dev.sh`: проверка `node`/`python3`; поднять uvicorn (`--port 8765`, env `VL_TOKEN`, `VL_DATA_DIR`), дождаться `/api/health`, запустить Vite, запустить Electron; `trap` убивает всех детей по Ctrl+C. Порт Vite — прокси на `8765` в `vite.config.ts`.
5. `scripts/test.sh`: `ruff check`, `pytest backend/tests`, `vitest run`; ненулевой код при падении любого шага.
6. `README.md`: раздел «Dev-режим» (установка, `npm run dev`, тесты, где данные и логи).
**Готово, когда:** на чистом клоне `npm install && npm run dev` поднимает три процесса, окно открывается; `scripts/test.sh` исполняется и возвращает 0 при отсутствии тестов.
**Оценка:** 0.25 д.

### T-01.2. Backend-ядро: приложение, БД, миграции, health, auth, статика
**Файлы:** `backend/app/main.py`, `backend/app/config.py`, `backend/app/db.py`, `backend/app/deps.py`, `backend/app/models.py`, `backend/app/routers/health.py`, `backend/app/routers/static.py`, `backend/app/utils/logging.py`, `backend/app/utils/paths.py`, `backend/app/migrations/001_init.sql`, `002_video_meta.sql`, `003_settings_fs.sql`, `backend/tests/conftest.py`.
**Что сделать:**
1. `config.py`: pydantic-настройки из env (`VL_TOKEN`, `VL_DATA_DIR`, `VL_RESOURCES_DIR`, `VL_FRONTEND_DIR`); создать каталоги `logs/`, `cache/thumbs/`, `tmp/`; значения по умолчанию по `00` §7.
2. `db.py`: `connect()` (новое соединение на запрос, `row_factory`, PRAGMA), `migrate()` — чтение `migrations/*.sql` по номеру, пропуск `≤ user_version`, одна транзакция на файл, обновление `PRAGMA user_version`.
3. `main.py`: `create_app()` — lifespan (логи, миграции, каталоги, инициализация `EventBus`), middleware токена для `/api/*`, подключение роутеров, статический fallback SPA. Отдельный `run()`: bind `127.0.0.1:0` (или `VL_DEV_BACKEND_PORT`), печать `VL_READY:{"port":N}` в stdout, затем `uvicorn.Server.run(sockets=[sock])`.
4. `routers/health.py`: `/api/health` с проверкой `SELECT 1`; версия из константы приложения.
5. `routers/static.py`: монтирование `frontend/dist` (если каталог есть); файл index и fallback для клиентских маршрутов; `Cache-Control: no-store` для `index.html`, хэшированные ассеты кэшируются долго.
6. `utils/logging.py`: RotatingFileHandler 10 МБ × 5 + stderr; перехват логов uvicorn; фильтр, скрывающий `VL_TOKEN`.
7. `conftest.py`: фикстуры `tmp_data_dir`, `app` (ASGI-приложение с tmp-БД), `client` (`httpx.ASGITransport`), тестовый токен.
**Готово, когда:** в чистом `VL_DATA_DIR` создаётся `library.db` с `user_version=3`; повторный запуск не меняет данные; `/api/health` с токеном отвечает `ok`, без токена — 401; `VL_READY` печатается до начала обслуживания запросов.
**Оценка:** 0.4 д.

### T-01.3. Electron main: окно, CSP, single-instance, супервизия sidecar
**Файлы:** `electron/main.ts`, `electron/backend.ts`, `electron/logger.ts`, `electron/ipc-channels.ts`, `scripts/build-electron.mjs`.
**Что сделать:**
1. `main.ts`: single-instance через `app.requestSingleInstanceLock()` (`second-instance` → фокус окна); `BrowserWindow` 1400×900, `minWidth: 1024`, `minHeight: 700`, `show: false` до `ready-to-show`; `webPreferences`: `preload`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
2. CSP-заголовок и политика из D-01.3; `webContents.setWindowOpenHandler` → `shell.openExternal` для http/https, иначе `deny`; `will-navigate` вне своего origin отменяется; DevTools только при `!app.isPackaged`.
3. `backend.ts`: `start()` — спавн команды бэкенда (dev — ничего не спавнить, prod — путь из `process.resourcesPath`), генерация токена, проброс env, чтение stdout построчно, ожидание `VL_READY` ≤ 15 с, парсинг порта, health-опрос 5 с; `ensureHealthy()`, `restart()` с backoff, `stop()` (SIGTERM → 3 с → SIGKILL); события `starting|ready|crashed|stopped` в renderer.
4. `logger.ts`: `logs/electron.log`, запись с уровнями, ротация при старте.
5. `scripts/build-electron.mjs`: esbuild-сборка `electron/main.ts` и `electron/preload.ts` в `dist-electron/` (external: `electron`), watch-режим для dev.
**Готово, когда:** окно открывается с заданными размерами и не ресайзится меньше min; второй запуск фокусирует первое окно; `kill -9` бэкенда перезапускает sidecar (не более 3 раз), статусы видны в renderer; закрытие окна не оставляет процессов `uvicorn`/`python`; CSP-заголовок присутствует в ответе документа.
**Оценка:** 0.4 д.

### T-01.4. Preload, `window.vl`, IPC-хендлеры и клиентский API-слой
**Файлы:** `electron/preload.ts`, `electron/ipc-channels.ts` (owner), `frontend/src/api/client.ts`, `frontend/src/api/types.ts`, `frontend/src/api/electron.ts`, `frontend/src/lib/time.ts`.
**Что сделать:**
1. `preload.ts`: `contextBridge.exposeInMainWorld('vl', …)` строго по интерфейсу `00` §6; подписка `onBackendStatus` возвращает функцию отписки; никаких `ipcRenderer`-объектов наружу.
2. IPC-хендлеры в `main.ts`: `openFiles` (фильтры `mp4/mkv/mov/avi/webm/m4v`), `openFolder`, `revealInExplorer`, `openExternal` (валидация протокола), `getAppInfo` (`version`, `dataDir`, `logsDir`), `log`.
3. `ipc-channels.ts`: единые константы каналов + TS-типы запросов/ответов; те же типы импортируются в `frontend/src/api/types.ts`.
4. `client.ts`: одноразовая инициализация `{baseUrl, token}` через `window.vl.getBackend()`; `request()` с `X-VL-Token`, разбор `{detail, code}` в `AppError`, таймаут 30 с; `getHealth()`, `getSettings()`, `patchSettings()`, `sseUrl()` (добавляет `?token=`).
5. `time.ts`: `formatTimecode(ms)`, `formatDuration(ms)` по `00` §8 (MM:SS / HH:MM:SS).
**Готово, когда:** в собранном renderer-bundle нет `ipcRenderer` (проверка `grep` в `scripts/ci.sh`); типы `VLApi` совпадают в preload и frontend; клиент получает 401 без токена и 200 с токеном.
**Оценка:** 0.2 д.

### T-01.5. Frontend-каркас: layout-заглушка, статус бэкенда, `useSSE`
**Файлы:** `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/hooks/useSSE.ts`, `frontend/src/state/uiStore.ts`, `frontend/src/components/Toolbar.tsx`, `frontend/src/components/FileList.tsx`, `frontend/src/components/sidebar/Sidebar.tsx`, `frontend/src/components/ui/EmptyState.tsx`, `frontend/src/styles/tokens.css`, `frontend/src/styles/global.css`, `frontend/src/lib/i18n/ru.json`.
**Что сделать:**
1. Собрать каркас раскладки `TARGET.md` §2: toolbar, левая панель с табами «Файлы»/«Теги», центральная область; все кнопки неактивны (tooltip «будет в M2/M4»), поле поиска disabled.
2. `uiStore` (zustand): `backendStatus`, `settings`, `sseConnected`, `toasts`; `useSSE` — `EventSource` через `client.sseUrl()`, реконнект 1→30 с с backoff, обновление `sseConnected`.
3. Баннер состояния: «Запуск бэкенда…», «Готов», «Бэкенд перезапускается (N/3)», «Бэкенд недоступен» с кнопкой «Перезапустить» (через `window.vl`) и кнопкой «Открыть логи» (`revealInExplorer`).
4. `EmptyState`: текст «Скелет M1: выберите папку после M2» по `TARGET.md` §2.3.
5. `tokens.css` — CSS-переменные `--vl-*` (цвета light/dark по `prefers-color-scheme`), базовые размеры; `i18n/ru.json` — все строки каркаса.
**Готово, когда:** prod-сборка открывается с backend-origin и не делает запросов к 5173; при остановленном бэкенде баннер переходит в «недоступен»; SSE-подключение видно в devtools (Network) и восстанавливается после рестарта бэкенда.
**Оценка:** 0.25 д.

### T-01.6. SSE-каркас и `/api/settings` на бэкенде
**Файлы:** `backend/app/routers/events.py`, `backend/app/routers/settings.py`, `backend/app/services/events.py`, `backend/app/services/settings_service.py`, `backend/app/models.py`.
**Что сделать:**
1. `EventBus`: `subscribe()`/`unsubscribe()`, `publish(type, payload)`; конверт события с `type`, `ts` (ISO-8601 UTC), `payload`; ограничение очереди (256 событий, старые вытесняются).
2. `GET /api/events`: проверка токена (query), `EventSourceResponse`, heartbeat 15 с, корректное удаление подписчика в `finally`.
3. `settings_service`: whitelist-ключи и дефолты (`language=auto`, `whisper_model=small`, `theme=system`, плюс ключи M6/M9 — канон `./00-conventions.md` §4.1 п.1), чтение/запись JSON в `settings`, валидация значений; `GET` (плоский объект) и `PATCH` (частичный объект) в `routers/settings.py`; после PATCH — `EventBus.publish("settings.changed", {keys:[…]})`.
4. Тесты API-уровня: 401 без токена на `/api/events`; PATCH меняет значение; неизвестный ключ — 400; `settings.changed` приходит подписчику.
**Готово, когда:** `curl -N '…/api/events?token=…'` получает heartbeat и событие после PATCH; значения сохраняются между рестартами; утечек подписчиков нет (проверка счётчика в тесте).
**Оценка:** 0.2 д.

### T-01.7. Тесты, e2e-smoke и документация каркаса
**Файлы:** `backend/tests/test_health.py`, `test_auth.py`, `test_migrations.py`, `test_settings.py`, `frontend/src/lib/time.test.ts`, `frontend/src/api/client.test.ts`, `e2e/smoke.spec.ts`, `scripts/ci.sh`, `docs/architecture.md`.
**Что сделать:**
1. pytest: health 200/401/503, миграции (идемпотентность, `user_version`, наличие таблиц 001–003), WAL/`foreign_keys`, settings CRUD, SSE-подписка (ASGI-стриминг с ограничением по времени).
2. vitest: `formatTimecode`, парсинг ошибок `client.ts`, установка `X-VL-Token`.
3. Playwright `_electron`: запуск приложения, заголовок окна, размеры ≥ 1024×700, индикатор «Готов», закрытие окна → процесс завершился, tmp-БД создана; отдельный тест — `SIGKILL` sidecar → окно показывает «перезапуск» и восстанавливается.
4. `scripts/ci.sh`: `ruff`, `pytest`, `vitest`, `tsc --noEmit`, `playwright test` (под `xvfb-run` в CI).
5. `docs/architecture.md`: одна страница — процессы, handshake, порты, пути, где логи (черновик, обновляется в M8/M10).
**Готово, когда:** `scripts/ci.sh` зелёный на чистом окружении; e2e-smoke проходит; архитектурный документ содержит схему запуска.
**Оценка:** 0.3 д.

Сумма оценок: 0.25 + 0.4 + 0.4 + 0.2 + 0.25 + 0.2 + 0.3 = **2.0 д** (верхняя граница диапазона 1–2 дня; буфер не заложен).

## 6. UI/UX-спецификация

Этап вводит только каркас интерфейса; данных ещё нет, все интерактивные элементы, кроме выбора папок/файлов (диалоги ОС), неактивны.

| Элемент | Поведение M1 |
|---|---|
| Окно | 1400×900, min 1024×700, заголовок «VideoLessons», в dev — «VideoLessons (dev)» |
| Toolbar | Кнопки `＋ В анализ`, `－ Из анализа`, поле поиска — disabled с tooltip «Появится в M2/M4» |
| Левая панель | Табы «Файлы» / «Теги»; содержимое — `EmptyState` «Панель появится в M2/M6» |
| Центральная область | `EmptyState` с текстом о готовности каркаса и подсказкой добавить папку после M2 |
| Индикатор бэкенда | Строка статуса в правом нижнем углу: `Запуск…` / `Готов` / `Перезапуск N/3` / `Недоступен` |
| Экран ошибки | При статусе `crashed` поверх контента: текст ошибки, кнопки «Перезапустить бэкенд», «Открыть логи» |
| Загрузка | Окно показывается сразу после `ready-to-show`; до статуса `ready` — скелетон с баннером, без белого экрана |
| Тема | CSS-переменные light/dark по `prefers-color-scheme`; переключатель темы — M9 |
| Клавиатура | Специальных горячих клавиш нет; Tab-навигация по видимым элементам сохраняется |
| i18n | Все строки через `t('…')` из `i18n/ru.json` |

## 7. Тесты и проверки

| Проверка | Инструмент | Где | Ожидаемый результат |
|---|---|---|---|
| Схема БД на чистом каталоге | pytest + sqlite3 | `backend/tests/test_migrations.py` | `user_version=3`, таблицы 001–003 присутствуют |
| Идемпотентность миграций | pytest | `test_migrations.py` | повторный запуск не меняет `user_version` и данные |
| PRAGMA-инварианты | pytest | `test_migrations.py` | `journal_mode=wal`, `foreign_keys=1` на соединении |
| Auth: header / query / отсутствие | pytest (`httpx.ASGITransport`) | `test_auth.py` | 200 / 200 / 401 `{"detail":"unauthorized"}` |
| Health при недоступной БД | pytest (monkeypatch connect) | `test_health.py` | 503, `db:"error"` |
| Инициализация настроек | pytest | `test_settings.py` | дефолты при первом GET; PATCH сохраняется после пересоздания приложения |
| SSE-каркас | pytest (стриминг с таймаутом) | `test_settings.py` | heartbeat + `settings.changed`, подписчик удалён после разрыва |
| Парсинг `VL_READY` и таймаут | node-тест `backend.ts` (vitest node-env) | `electron/backend.test.ts` | корректный порт; при отсутствии строки — ошибка за ≤ 15 с |
| CSP и запрет навигации | e2e Playwright `_electron` | `e2e/smoke.spec.ts` | заголовок CSP присутствует; `window.open` не создаёт окно |
| Окно и single-instance | e2e | `e2e/smoke.spec.ts` | размеры 1400×900, min-ограничение; второй экземпляр не открывает новое окно |
| Рестарт sidecar | e2e + `kill -9` | `e2e/smoke.spec.ts` | статус `crashed` → `ready`; после 3 сбоев — экран ошибки |
| Чистое завершение | e2e | `e2e/smoke.spec.ts` | после закрытия окна нет процессов `python`/`uvicorn` |
| Отсутствие сети | ручной смоук + статический аудит зависимостей | `docs/architecture.md` (раздел «Сеть») | нет внешних запросов; проверка `ss -tp` на dev-сборке |
| `window.vl`-контракт | grep по собранному renderer-bundle | `scripts/ci.sh` | нет `ipcRenderer`; методы совпадают с `00` §6 |

## 8. Критерии готовности и коммиты

**DoD (чек-лист):**
- [ ] `npm run dev` на чистом клоне поднимает Vite + uvicorn + Electron, окно открывается.
- [ ] Окно 1400×900, минимальные размеры 1024×700, single-instance работает.
- [ ] Бэкенд слушает `127.0.0.1` (dev — 8765, prod — динамический порт из handshake), `/api/health` отвечает.
- [ ] `VL_TOKEN` проверяется на всех `/api/*`, для `/api/events` — через query; 401 без токена.
- [ ] БД создаётся пустой (нет пользовательских данных), миграции 001–003 применяются идемпотентно.
- [ ] Sidecar-рестарт ≤ 3 раз с backoff; после — экран ошибки; закрытие приложения не оставляет процессов.
- [ ] SSE-каркас и `/api/settings` (GET/PATCH) реализованы и покрыты тестами.
- [ ] CSP, `contextIsolation`, `sandbox`, запрет навигации и `window.open` включены.
- [ ] `scripts/ci.sh` зелёный: ruff, pytest, vitest, tsc, Playwright smoke.
- [ ] `docs/architecture.md` (черновик) и README-раздел dev созданы; критерий «Готово, когда» из `TARGET.md` §6 подтверждён вручную.

**Ожидаемые коммиты (Conventional Commits):**
```text
feat(m1): scaffold electron, vite and python workspace with dev scripts
feat(m1): sqlite bootstrap with forward-only migrations
feat(m1): sidecar handshake and supervised backend process
feat(m1): sse event bus and settings api carcass
feat(m1): contextBridge api and frontend shell
test(m1): backend, frontend and electron smoke coverage
```
Допускается объединение последних двух коммитов; история должна оставаться рабочей на каждом коммите.

## 9. Риски и откаты

| Риск | Вероятность | Влияние | Откат / меры |
|---|---|---|---|
| Sidecar не стартует (неверная команда, отсутствует Python/бинарник, падение на импорте) | Средняя | Блокирует весь этап и все последующие | Диагностика в `electron.log` (stdout/stderr sidecar пишутся в файл); таймаут 15 с; экран ошибки с кнопкой перезапуска; dev-режим запускает бэкенд из `scripts/dev.sh`, что изолирует проблему Electron-супервизии |
| Порт занят (dev 8765 или гонка при динамическом выборе) | Средняя | Бэкенд не поднимается / неверный порт | Prod всегда `127.0.0.1:0`; при занятом 8765 dev-скрипт предлагает `VL_DEV_BACKEND_PORT`; проверка в `scripts/dev.sh`; ошибка `EADDRINUSE` логируется с понятным сообщением |
| CSP блокирует Vite HMR / inline-стили, «белый экран» в dev | Высокая | Ложные сбои разработки | Отдельная dev-CSP (D-01.3), проверка заголовка в e2e; prod-CSP ужесточается только после зелёного e2e на prod-сборке |
| `sandbox: true` ломает preload (недоступен `require`/буферизация) | Средняя | `window.vl` не появляется, UI мёртв | Preload собирается одним CJS-бандлом без внешних зависимостей; проверка `window.vl` в e2e первым шагом; при непреодолимой проблеме — `sandbox: false` только с фиксацией в «Открытых вопросах» (A2 не меняется без согласования) |
| Миграции повреждают dev-БД при отладке | Низкая | Потеря локальных данных, блокировка этапа | Forward-only + транзакция на файл; резервная копия `library.db` в dev-скрипте перед стартом (опционально); пересоздание БД из `VL_DATA_DIR` |
| Утечка сиротских процессов при падении Electron | Средняя | Зависшие порты и CPU, ложные тесты | `before-quit` + SIGTERM/SIGKILL, health-контроль; e2e-проверка отсутствия процессов; kill по PID в `scripts/dev.sh` |

## 10. Трассировка и ссылки

**Разделы спеки:** `../TARGET.md` §1 (стек), §2 (внешний вид, каркас), §3.1 (целевые форматы — задел M2), §4 (базовые таблицы), §5 (`/health`, `/events`, `/settings`), §6 M1 («Готово, когда»), §7 п.1, п.8, п.9, п.10 (частично), §8 (RAM/CPU/безопасность/логи), §9 (запреты: динамический порт, sandbox, без сети).

**Контракты:** `./00-conventions.md` §2 (A1–A6, A12–A14), §3 (структура репозитория), §4 (API), §5 (миграции 001–003), §6 (`window.vl`), §7 (пути/порт/токен), §8 (код и данные), §9 (тестовая стратегия), §10 (шаблон плана).

**Соседние планы:** `./02-library-m2.md` (потребитель `folder_stats`, `/api/videos`, `/api/fs/list`), `./03-transcription-m3.md` (потребитель `events`, `settings.language/whisper_model`), `./04-search-m4.md` (миграция FTS 004 на базе 001), `./05-player-timings-m5.md` (consumer `baseUrl`, статика SPA), `./07-annotations-m7.md` (M1 поставляет базовую таблицу `annotations` и SSE-каркас для будущего `annotations.changed`), `./08-packaging-m8.md` (пути `VL_RESOURCES_DIR`, `VL_FRONTEND_DIR`, PyInstaller), `./09-polish-m9.md` (полный settings-диалог и темы), `./10-acceptance-ci.md` (e2e- и CI-контуры).

**Критерии приёмки `TARGET.md` §7 → проверка этапа:**

| Критерий приёмки | Покрытие в M1 | Где проверяется |
|---|---|---|
| §7 п.1 «Первый запуск < 5 с» | Частично: замер времени от старта Electron до статуса `ready`; установка на чистую VM — M8/M10 | `e2e/smoke.spec.ts`, `docs/acceptance.md` (M10) |
| §7 п.8 «Перезапуск: состояние восстановлено» | Частично: настройки и БД переживают рестарт, путь данных стабилен; панели/UI — M9 | `test_settings.py`, e2e-перезапуск |
| §7 п.9 «Остановка обработки ≤ 5 с» | Каркас: sidecar завершается ≤ 3 с (SIGTERM) + 3 с (SIGKILL); обработка — M3 | e2e «чистое завершение», `./03-transcription-m3.md` |
| §7 п.10 «Нет сети» | Частично: аудит зависимостей, отсутствие внешних URL в коде, `ss -tp`-смоук; полная проверка — M10 | `docs/architecture.md`, `./10-acceptance-ci.md` |

### Открытые вопросы

1. **Форма `/api/settings` — решено:** канон в `00` §4.1 п.1 (плоский объект, частичный `PATCH`, ключи `language`, `whisper_model`, `theme`, `tags.*`, `log.level`, `ui.sort`); M1 реализует его, чтобы M3/M6/M9 не расходились.
2. **Конверт SSE** не зафиксирован в `00` §2 (A5) — только имена событий. Предложен `{type, ts, payload}`; от него зависят `useSSE` (M1) и прогресс/очередь (M3).
3. **`VL_FRONTEND_DIR`** — решено: внесён в `00` §7 (значение по умолчанию; M8 кладёт SPA в `${VL_RESOURCES_DIR}/frontend/dist`).
4. **Правило §6 «`window.vl` только через слой `api/*`»** — решено (`00` §4.1 п.7): обёртка `api/electron.ts`, прямой вызов из компонентов запрещён.
5. **`/api/health` vs `/health`**: `TARGET.md` §5 даёт `/health` при префиксе `/api`, `00` §4 — `/api/health`. Принят `/api/health`; просьба подтвердить, что внешних потребителей без префикса нет.
6. **Коды ответа health при недоступной БД** не заданы: предложен 503 `{"status":"degraded","db":"error"}`. Если Electron должен считать любой 200 признаком живости, просьба зафиксировать в `00`.
7. **Статус `sandbox: true` и preload**: если Electron 31+ потребует исключений для preload, изменение A2 возможно только через согласование; в M1 обходных путей не закладываем.

