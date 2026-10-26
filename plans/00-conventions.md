# 00. Соглашения, контракты и шаблон планов

> Статус: **обязательный** для всех файлов `plans/*.md`. Если план противоречит этому документу — прав этот документ, противоречие фиксируется в разделе «Открытые вопросы» плана и сообщается Lead'у.
>
> Источник требований: `TARGET.md` (в задаче пользователь называет его PLAN.md). Мастер-план и индекс: `PLAN.md`.

---

## 1. Назначение документов

| Файл | Роль |
|---|---|
| `TARGET.md` | Исходная спека (400 строк): миссия, стек, UI, требования, схема БД, API, этапы M1–M9, критерии приёмки. **Не редактируется.** |
| `PLAN.md` | Мастер-план: анализ спеки, найденные пробелы, архитектурные решения, роадмап, матрица приёмки, риски, индекс. |
| `plans/00-conventions.md` | Этот файл: контракты (репозиторий, API, БД, IPC, сборка), шаблон планов, правила ведения работ. |
| `plans/01…10-*.md` | Детальные планы этапов. Один этап = один файл. |

Ссылки между документами — относительные (`../TARGET.md`, `./04-search-m4.md`). Анкоры к разделам спеки — по заголовку, например `../TARGET.md` §3.3.

## 2. Ключевые архитектурные решения (ADR, сокращённо)

Решения приняты Lead'ом и **не пересматриваются** в планах этапов. Обоснование изменения — только через «Открытые вопросы».

| # | Решение |
|---|---|
| **A1** | Продакшн-рендерер грузит SPA с бэкенда: `http://127.0.0.1:<port>/`. Бэкенд монтирует `frontend/dist` как статику. Файлов `file://` и CORS нет. В dev: Vite (`:5173`) + прокси `/api` → uvicorn (`:8765`). |
| **A2** | Безопасность окна: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. Renderer общается с ОС только через `window.vl` (preload + `contextBridge`). |
| **A3** | Handshake: Electron генерирует `VL_TOKEN` (`crypto.randomBytes(32).toString('hex')`), передаёт через env `VL_TOKEN`, `VL_DATA_DIR`, `VL_RESOURCES_DIR`. Бэкенд слушает `127.0.0.1:0` и печатает в stdout одну строку `VL_READY:{"port":<n>}`; Electron ждёт её ≤ 15 с. |
| **A4** | Авторизация: middleware требует `X-VL-Token` для всех `/api/*` (включая `/api/health`); несовпадение → `401 {"detail":"unauthorized"}`. **Исключение (ратифицировано):** query-параметр `?token=` допускается только для `/api/events` (`EventSource`) и `/api/videos/{id}/stream` (`<video src>` не умеет заголовки). Превью `/thumb` грузится через `fetch` + `blob:`-URL (M2), query-токен для него не нужен. Токен не пишется в логи, query вырезается из access-логов; для media-ответов — `Referrer-Policy: no-referrer`. |
| **A5** | События: SSE (`text/event-stream`, библиотека `sse-starlette`), канал `/api/events`. Конверт: `event: <type>` + `data: {"type": "<type>", "ts": "<ISO-8601 UTC>", "payload": {…}}`; heartbeat 15 с. Типы: `video.status`, `video.progress`, `queue.state`, `folder.scanned`, `tags.changed`, `annotations.changed`, `settings.changed`, `backend.error`. Payload’ы — `plans/01` §4.1, `plans/02` §4.3, `plans/03` §4.3, `plans/06` §4.1, `plans/07` §4.4, `plans/09` §4.1. |
| **A6** | Транскрипция: `ProcessPoolExecutor(max_workers=1)` над `faster-whisper`; event loop FastAPI не блокируется. Очередь FIFO в памяти, статусы — в `videos.status`. На старте `processing` → `queued` (crash-recovery). Отмена — через `multiprocessing.Event` + `terminate()` с grace 3 с. |
| **A7** | БД: SQLite WAL (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`), соединение на запрос, `timeout=30`. Миграции forward-only, `PRAGMA user_version`, файлы `backend/app/migrations/NNN_*.sql`, применяются на старте. |
| **A8** | Поиск: FTS5 `unicode61 remove_diacritics 2` для `segments` и `annotations` (external content + триггеры). Пользовательский запрос санитизируется; `AND/OR/NOT` и кавычки допускаются, прочий синтаксис FTS5 — нет. Сниппеты — через `snippet()` с маркерами `<mark>…</mark>`. |
| **A9** | Единый поиск: `GET /api/search` c `scope=all|files|segments|annotations`; элементы результата различаются полем `kind`. Это точка расширения для поиска по пользовательским меткам (требование пользователя). |
| **A10** | Сборка релиза — **только** в контейнере `ubuntu:22.04` (Docker): PyInstaller `--onedir`, electron-builder. Dev-машина (Gentoo, Python 3.14, Node 26) для релиза не используется: glibc/ffmpeg-бинарь должны быть совместимы с целевой Ubuntu 22.04+. |
| **A11** | Ресурсы: статические `ffmpeg`+`ffprobe` (johnvansickle; лицензия — решается в M8: LGPL-сборка либо GPL + `SOURCE-OFFER`/тексты) и модель `faster-whisper small` (CTranslate2, INT8) кладутся в `extraResources` вместе с `THIRD-PARTY-NOTICES.md`; в рантайме путь берётся из `VL_RESOURCES_DIR`. В пакет кладётся **только** модель `small` (офлайн-размер); остальные модели в UI видны, но недоступны с пояснением. Сеть в рантайме не используется. |
| **A12** | Настройки: БД-таблица `settings(key TEXT PRIMARY KEY, value TEXT)`; UI-состояние (ширины панелей, сворачивание таймингов, тема) — `localStorage`, ключи с префиксом `vl.`. |
| **A13** | Логи: `logs/backend.log` (RotatingFileHandler, 10 МБ × 5, INFO), `logs/electron.log`; ошибки рендерера уходят в main через IPC `vl:log`. |
| **A14** | Тесты: backend — `pytest` (+ `httpx.ASGITransport`, tmp-БД); frontend — `vitest` + `@testing-library/react`; e2e-smoke — Playwright `_electron` (M1, M5, M7). Приёмка — `scripts/acceptance.sh` + чек-лист `docs/acceptance.md`. |
| **A15** | Язык UI — русский, строки в `frontend/src/lib/i18n/ru.json`, доступ через `t('ключ')`. Время в БД/API — целые миллисекунды; даты — ISO-8601 UTC. |

## 3. Структура репозитория

```
agent_digikam/                    # корень проекта
├── TARGET.md                     # исходная спека (read-only)
├── PLAN.md                       # мастер-план
├── plans/                        # планы этапов (этот каталог)
├── electron/
│   ├── main.ts                   # lifecycle, окно, single-instance, CSP
│   ├── backend.ts                # spawn sidecar, VL_READY, restart, graceful stop
│   ├── preload.ts                # contextBridge → window.vl
│   ├── ipc-channels.ts           # единый список каналов + типы
│   ├── menu.ts                   # меню приложения, горячие клавиши уровня ОС
│   └── logger.ts
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx, App.tsx
│       ├── api/        client.ts, sse.ts, electron.ts (обёртка window.vl), types.ts
│       ├── state/      libraryStore.ts, playerStore.ts, tagsStore.ts,
│       │               annotationsStore.ts, searchStore.ts, uiStore.ts
│       ├── components/
│       │   ├── Toolbar.tsx, FileList.tsx, SearchResults.tsx
│       │   ├── sidebar/ Sidebar.tsx, FolderTree.tsx, TagTree.tsx
│       │   ├── player/  VideoPlayer.tsx, Timeline.tsx, TimingPanel.tsx,
│       │   │            SegmentRow.tsx, AnnotationRow.tsx, AnnotationMarker.tsx
│       │   ├── annotations/ AnnotationEditor.tsx, AnnotationList.tsx,
│       │   │                ColorSwatchPicker.tsx, TagPicker.tsx
│       │   ├── dialogs/ SettingsDialog.tsx, ConfirmDialog.tsx, HotkeysDialog.tsx
│       │   └── ui/      Toast.tsx, ContextMenu.tsx, EmptyState.tsx, Spinner.tsx
│       ├── hooks/      useSSE.ts, useHotkeys.ts, useDebounce.ts, useResizable.ts,
│       │               usePlaybackClock.ts
│       ├── lib/        time.ts, i18n/, format.ts, constants.ts, storage.ts, hotkeys.ts
│       └── styles/     tokens.css, global.css
├── backend/
│   ├── pyproject.toml (или requirements.txt)
│   ├── app/
│   │   ├── main.py            # create_app(), lifespan, middleware, static mount
│   │   ├── config.py          # пути, env, настройки по умолчанию
│   │   ├── db.py              # connect(), migrate(), pragmas
│   │   ├── migrations/        001_init.sql, 002_fts.sql, …
│   │   ├── models.py          # pydantic-схемы запросов/ответов
│   │   ├── deps.py            # get_db, get_settings, require_token
│   │   ├── routers/           health.py, videos.py, folders.py, fs.py, tags.py,
│   │   │                      annotations.py, search.py, events.py, settings.py,
│   │   │                      queue.py, static.py
│   │   ├── services/          scanner.py, probe.py, thumbnail.py, watcher.py,
│   │   │                      queue.py, transcriber.py, search_service.py,
│   │   │                      tags_service.py, annotations_service.py,
│   │   │                      settings_service.py, events.py
│   │   └── utils/             paths.py, sha256.py, logging.py, timefmt.py,
│   │                          fts_query.py
│   ├── worker/                transcribe_worker.py (entrypoint процесса)
│   └── tests/                 conftest.py, test_*.py, fixtures/
├── resources/
│   ├── ffmpeg/                ffmpeg, ffprobe (скачиваются скриптом, не в git)
│   └── models/faster-whisper-small/   CTranslate2-модель (не в git)
├── packaging/
│   ├── backend.spec           # PyInstaller
│   ├── electron-builder.yml
│   ├── linux/                 # videolessons.desktop, after-install.tpl, apparmor/
│   └── docker/Dockerfile.build
├── scripts/
│   ├── dev.sh, fetch-ffmpeg.sh, fetch-model.sh
│   ├── build-backend.sh, build-electron.sh, make-release.sh
│   ├── test.sh, ci.sh, acceptance.sh
│   ├── measure.sh, measure-startup.sh, vm-smoke.sh
├── docs/
│   ├── architecture.md, user-guide.md, acceptance.md, acceptance.template.md, screens/
└── dist/                      # артефакты релиза (gitignored)
```

## 4. Контракт API

Префикс `/api`. Все ответы JSON; ошибки `{"detail": "<текст>", "code": "<машинный_код>"}` + HTTP-код. Списочные ответы: `{"items": [...], "total": N}`.

| Метод | Path | Этап | Назначение |
|---|---|---|---|
| GET | `/api/health` | M1 | `{"status":"ok","version":"…","db":"ok"}`; `503 {"status":"degraded"}` при недоступной БД |
| GET | `/api/videos` | M2 | фильтры `folder`, `tag_ids` (CSV), `tag_mode=any\|all`, `include_children=1\|0`, `status` (CSV), `q`, `sort`, `dir`, `limit` (50, max 500), `offset`; ответ `{items,total}` |
| POST | `/api/videos/scan` | M2 | `{path}` (файл или каталог) → `202 {scan_id, state:"running", root}`; вне watched-корней — `403`; завершение — SSE `folder.scanned` |
| POST | `/api/videos/enqueue` | M3 | `{ids:[]}` → `200 {queued:[], skipped:[{id,reason}]}` |
| DELETE | `/api/videos/{id}` | M2 | `204`, удалить из индекса (файл не трогать) |
| POST | `/api/videos/{id}/reprocess` | M3 | `202 {id,status:"queued"}`; `409`, если уже обрабатывается |
| POST | `/api/videos/{id}/cancel` | M3 | `200 {id,status:"pending"}`; идемпотентно; `409` для `done/error` |
| GET | `/api/videos/{id}/stream` | M5 | 206 Range-стриминг (`Accept-Ranges: bytes`); `?token=` разрешён (A4) |
| GET | `/api/videos/{id}/thumb` | **M2** (базовый кэш), M5 (`?at_ms=`) | JPEG-превью; кэш `cache/thumbs`; авторизация — `fetch`+`blob` (A4) |
| GET | `/api/videos/{id}/segments` | M5 | `{segments:[…, tag_ids], annotations:[…]}` |
| GET | `/api/search` | M4 | `q`, `scope`, `video_id`, `tag_ids`, `tag_mode`, `include_children`, `colors`, `limit` (20, max 100), `offset`; ответ включает `query.took_ms` |
| GET | `/api/tags/tree` | M6 | дерево + счётчики `{files, segments, annotations, children}`, `?include_counts=1` |
| POST/PATCH/DELETE | `/api/tags`, `/api/tags/{id}` | M6 | CRUD; PATCH принимает `{name?, color?, parent_id?}` (перемещение) |
| GET | `/api/tags/export`, POST `/api/tags/import` | M6 | JSON, `?mode=merge\|replace&dry_run=1` |
| POST | `/api/videos/{id}/tags` | M6 | `{tag_id}` (идемпотентно) |
| DELETE | `/api/videos/{id}/tags/{tag_id}` | M6 | снять тег |
| POST/DELETE | `/api/segments/{id}/tags`, `/api/segments/{id}/tags/{tag_id}` | M6 | теги сегментов (`segment_tags`) |
| GET | `/api/annotations` | M7 | фильтры `video_id`, `tag_id` (повторяемый), `color`, `q`, `limit`, `offset` |
| POST | `/api/annotations` | M7 | создать (валидация диапазона) |
| GET/PATCH/DELETE | `/api/annotations/{id}` | M7 | чтение/правка/удаление; PATCH — partial, `tag_ids` заменяет набор |
| POST | `/api/annotations/bulk` | M7 | массовое создание (drag-диапазон по строкам) |
| GET | `/api/annotations/export`, POST `/api/annotations/import` | M7 | JSON (`version:1`), `mode=merge\|replace` |
| GET | `/api/events` | M3 | SSE, `?token=…`; конверт — A5 |
| GET/POST/DELETE | `/api/folders`, `/api/folders/{id}` | M2 | отслеживаемые корни `{items:[{id,path,added_at,total,done}]}` |
| GET | `/api/fs/list` | M2 | `?path=`; `{path,parent,entries:[{name,path,mtime_ms,watched}]}` — только каталоги внутри watched-корней |
| GET/PATCH | `/api/settings` | M1/M9 | плоский объект ключей (§4.5); PATCH — частичный объект |
| GET | `/api/queue` | M3 | `{current:{video_id,title,progress}\|null, pending:[{video_id,position}], total}` |
| GET | `/api/models` | M9 | `{items:[{name,path,size_bytes,bundled,quantized}], total}` |
| POST | `/api/maintenance/clear-model-cache` | M9 | `{removed_bytes, removed_files}` |

Схема `/search` (единая, M4 создаёт каркас, M7 добавляет `kind:"annotation"`):

```json
{
  "query": {"raw": "…", "fts": "…", "scope": "all", "prefixes": {"tags": ["Учёба"], "file": null}},
  "total": 12,
  "items": [
    {"kind": "file", "video_id": 3, "video_title": "lesson-01.mp4", "path": "/…",
     "duration_ms": 754000, "snippet_html": "…<mark>слово</mark>…", "score": 1.42},
    {"kind": "segment", "video_id": 3, "video_title": "lesson-01.mp4",
     "segment_id": 41, "start_ms": 72000, "end_ms": 78000,
     "text": "…", "snippet_html": "…", "score": 2.10},
    {"kind": "annotation", "video_id": 3, "video_title": "lesson-01.mp4",
     "annotation_id": 7, "start_ms": 30000, "end_ms": 75000,
     "label": "важный пример", "note": "…", "color": "#3b82f6",
     "tag_ids": [2, 5], "snippet_html": "…", "score": 3.05}
  ]
}
```

Правила `q`: обычный текст → FTS5; `AND/OR/NOT` и фразы в кавычках — допустимы; `tag:<имя>` — фильтр по тегам (файла/сегмента/метки в зависимости от `scope`); `file:<текст>` — подстрока по имени файла. Проброс произвольного синтаксиса FTS5 запрещён.

### 4.1. Ратифицированные уточнения (решения Lead, обязательны)

1. **Настройки** — плоский объект; канон ключей: `language` (`auto|ru|en`), `whisper_model` (`tiny|base|small|medium`), `theme` (`light|dark|system`), `tags.multi_select_mode` (`union|intersection`, дефолт `union`), `tags.max_depth` (1–8, дефолт `5`), `log.level` (`INFO` дефолт; `DEBUG` допустим с предупреждением), `ui.sort` (`<поле>:<asc|desc>`). `GET /api/settings` → `{"language":"auto","whisper_model":"small","theme":"system","tags.multi_select_mode":"union","tags.max_depth":5,"log.level":"INFO"}`; `PATCH` — частичный объект, ответ — полный объект; неизвестный/невалидный ключ → `400 {code:"unknown_setting"|"invalid_setting"}`; изменение публикует `settings.changed {keys:[…]}`.
2. **Теги: семантика фильтров.** `tag:` фильтрует по тегам сущности своего `scope` (файлы → теги файла; сегменты → теги сегмента; метки → теги метки; `all` → объединение). `include_children=1` по умолчанию (клик по тегу показывает и дочерние — `TARGET.md` §2.2), `include_children=0` отключает. `tag_mode` по умолчанию `any` (объединение; соответствует настройке `tags.multi_select_mode=union`), `all` — пересечение. `tags.max_depth` — дефолт 5, API-лимит 8 (защита от циклов и патологий); глубже 5 — UI не предлагает, но данные не ломаются.
3. **Поиск.** `scope=all|files|segments|annotations`; в M4 `scope=annotations` возвращает валидный пустой ответ (провайдер регистрируется в M7). `limit` по умолчанию 20, максимум 100; `query.took_ms` — аддитивное поле времени ответа. Ошибки: `invalid_scope`, `invalid_limit`, `query_too_long` (422). Ранжирование: `score = -bm25(...)`, детерминированный tie-break (`score`, `kind`, `video_id`, `start_ms`).
4. **Стриминг и превью.** `?token=` — только `/api/events` и `/api/videos/{id}/stream`. `/thumb` реализует M2 (ленивый кэш, `?at_ms=` опционально расширяет M5); повторной реализации в M5 нет.
5. **SSE.** Конверт A5 (`{type, ts, payload}`); `folder.scanned` — завершение фонового скана; `tags.changed {rev, action, tag_ids}`; `annotations.changed {video_id, op, ids}`.
6. **Скан** — фоновый: `202 {scan_id, state, root}`, идемпотентность по корню, прогресс — поток `video.status`, завершение — `folder.scanned`.
7. **`window.vl`** доступен только через слой `frontend/src/api/*` (`client.ts`, `sse.ts`, `electron.ts`); прямой вызов из компонентов запрещён.
8. **Инфраструктура приёмки** (M10): `scripts/measure.sh`, `measure-startup.sh`, `vm-smoke.sh`, `docs/acceptance.template.md`, `dist/ci/SHA256SUMS`, `dist/acceptance/report.{json,md}`; коды выхода скриптов: `0` успех, `1` провал проверки, `2` ошибка окружения. Новый CLI-флаг `--acceptance-mode` **не вводится** — приёмка использует env `VL_DATA_DIR`/`VL_TOKEN`. Тест-контейнер может запускать Electron с `--no-sandbox`; запрет `TARGET.md` §9 относится к поставляемому артефакту.

## 5. Модель данных: базовые таблицы и дельта

Базовые таблицы — из `TARGET.md` §4. Обязательная дельта (фиксируется в `plans/00` и реализуется по этапам; менять имена нельзя):

```sql
-- 002: метаданные видео и файловая дата (M1 пишет схему, M2/M3 заполняют)
ALTER TABLE videos ADD COLUMN lang TEXT;              -- ISO-639-1, фактически определённый ('ru','en',…)
ALTER TABLE videos ADD COLUMN model TEXT;             -- 'small' | 'tiny' | …
ALTER TABLE videos ADD COLUMN headline TEXT;          -- первая фраза транскрипции (≤120 символов)
ALTER TABLE videos ADD COLUMN mtime_ms INTEGER;       -- mtime файла на диске (для колонки «Дата изменения», §2.3)

-- 003: настройки и файловая система (M1/M9)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE folder_stats (           -- кэш счётчиков для дерева (M2)
  folder_path TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 004: FTS по сегментам (M4)
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text, content='segments', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
-- триггеры INSERT/UPDATE/DELETE для синхронизации

-- 005: теги — индексы и регистронезависимая уникальность (M6)
CREATE INDEX idx_tags_parent ON tags(parent_id);
CREATE INDEX idx_tags_name ON tags(name COLLATE NOCASE);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
CREATE INDEX idx_segment_tags_tag ON segment_tags(tag_id);
CREATE UNIQUE INDEX ux_tags_parent_name ON tags(COALESCE(parent_id, 0), name COLLATE NOCASE);

-- 006: теги меток (M7) — в TARGET.md §4 отсутствует, но требуется §3.5
CREATE TABLE annotation_tags (
  annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tag_id)
);

-- 007: FTS по меткам + поля (M7)
ALTER TABLE annotations ADD COLUMN updated_at TEXT;
CREATE VIRTUAL TABLE annotations_fts USING fts5(
  label, note, content='annotations', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE INDEX idx_ann_start ON annotations(start_ms);
CREATE INDEX idx_ann_tags_tag ON annotation_tags(tag_id);
```

Инварианты: `annotations.end_ms > start_ms`, `start_ms >= 0`, `end_ms <= videos.duration_ms` (при известной длительности), `label` непустой (trim, ≤ 200 символов), `note` ≤ 2000, цвет — `#rrggbb`. Теги метки каскадно удаляются с меткой и с тегом. `segments`/`annotations`/`annotation_tags`/`segment_tags` — `ON DELETE CASCADE` от `videos`.

Инварианты данных (ратифицировано):

- `videos.status` ∈ `pending|queued|processing|done|error|duplicate|missing`; `duplicate` — файл пропущен при дедупликации (не индексируется повторно), `missing` — файл исчез с диска (watcher), запись сохраняется до ручного удаления; сканирование возвращает `missing` → `pending`.
- `videos.progress` — доля `0..1` (REAL), не проценты; `1.0` только при `done`; UI форматирует в `%`.
- `videos.mtime_ms` — mtime файла; колонка «Дата изменения» в списке (`TARGET.md` §2.3) берёт `mtime_ms`, при NULL — `added_at`.
- `videos.duplicate_of` (опционально, если M2 реализует) — id первичной записи; для `duplicate`-строк путь и title сохраняются.
- Миграции: `001–003` — M1, `004` — M4, `005` — M6, `006–007` — M7; номера не переиспользуются.

## 6. Контракт Electron ↔ Renderer

`window.vl` (preload, типы в `electron/ipc-channels.ts` и `frontend/src/api/types.ts`):

```ts
interface VLApi {
  getBackend(): Promise<{ baseUrl: string; token: string }>;
  openFiles(): Promise<string[]>;                 // диалог выбора видео
  openFolder(): Promise<string | null>;           // диалог выбора папки
  getPathForFile(file: File): string;             // путь из drag&drop (webUtils.getPathForFile)
  revealInExplorer(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  getAppInfo(): Promise<{ version: string; dataDir: string; logsDir: string }>;
  onBackendStatus(cb: (s: 'starting'|'ready'|'crashed'|'stopped') => void): () => void;
  log(level: 'info'|'warn'|'error', msg: string): void;
}
```

Правила: каналы именуются `vl:<domain>:<action>`; invoke-каналы — только через `ipcMain.handle`; никакого `ipcRenderer` в рендерере; `window.vl` вызывается **только через слой `frontend/src/api/*`** (`client.ts`, `sse.ts`, `electron.ts`), а не из компонентов напрямую. `getPathForFile` — синхронный метод `webUtils` в preload (не IPC-канал), экспортируется через `contextBridge`; fallback — `File.path` для Electron 31.

## 7. Пути, порт, конфиг

| Что | Значение |
|---|---|
| Данные | `${XDG_DATA_HOME:-~/.local/share}/VideoLessons/` (`VL_DATA_DIR`) |
| БД | `$VL_DATA_DIR/library.db` |
| Логи | `$VL_DATA_DIR/logs/` |
| Кэш превью | `$VL_DATA_DIR/cache/thumbs/` |
| Временные WAV | `$VL_DATA_DIR/tmp/` (удаляются после обработки) |
| Ресурсы | `VL_RESOURCES_DIR` (в dev — `./resources`, в prod — `process.resourcesPath`) |
| Сборка SPA | `VL_FRONTEND_DIR` — путь к `frontend/dist` для статики; по умолчанию `${VL_RESOURCES_DIR}/frontend/dist` (prod) и `<repo>/frontend/dist` (dev) |
| Порт dev | `8765` (`VL_DEV_BACKEND_PORT`) |
| Порт prod | динамический, `127.0.0.1:0` |
| Токен | `VL_TOKEN` (env), 64 hex-символа; query-исключения — A4 (`/api/events`, `/api/videos/{id}/stream`) |

## 8. Соглашения по коду и данным

- Python: `ruff` (line-length 100), типизация обязательна для публичных функций; слои `router → service → db`, SQL — только в сервисах/репозиториях, не в роутерах.
- TypeScript: strict, без `any` в публичных типах; состояние — zustand; серверные данные — через `api/client.ts`, SSE — через `hooks/useSSE.ts`.
- Имена: БД/JSON — `snake_case`; TS — `camelCase`; компоненты — `PascalCase`; CSS-переменные — `--vl-*`.
- Время: `*_ms` — целые; форматирование только через `lib/time.ts` (`formatTimecode(ms) → "MM:SS"`/`"HH:MM:SS"`).
- Ошибки: `AppError(code, detail, http_status)` на бэкенде; toast в UI; в лог — traceback.
- Никаких сетевых запросов из приложения (кроме 127.0.0.1-бэкенда).
- Секреты/токены — не логировать; токен не попадает в текст ошибок.
- Git: Conventional Commits (`feat(m2): …`, `fix(m5): …`, `docs(plans): …`); один этап — 3–8 коммитов; рабочее состояние на каждом коммите.

## 9. Тестовая стратегия (единая)

| Уровень | Инструмент | Где | Обязательность |
|---|---|---|---|
| Unit backend | pytest | `backend/tests/` | на каждый сервис |
| API-интеграция | pytest + `httpx.ASGITransport`, tmp-БД | `backend/tests/test_api_*.py` | на каждый роутер |
| Unit frontend | vitest | `frontend/src/**/*.test.ts(x)` | на утилиты, сторы, парсер времени |
| Компонентные | vitest + RTL | `frontend/src/components/**/*.test.tsx` | ключевые контролы (метки, поиск) |
| E2E smoke | Playwright `_electron` | `e2e/` | M1, M5, M7 |
| Приёмка | ручной чек-лист + `scripts/acceptance.sh` | `docs/acceptance.md` | перед релизом |
| Сборка | Docker `ubuntu:22.04` | `scripts/ci.sh` | каждый релиз-кандидат |

Правило: критерий приёмки из `TARGET.md` §7 обязан иметь в плане этапа конкретный тест (unit/integration/e2e/manual) — таблица трассировки в `PLAN.md`.

## 10. Шаблон файла плана (обязательный, дословно по заголовкам)

```markdown
# NN. M<k> — <Название этапа>

> Этап: M<k> · Оценка: <дни> · Зависит от: <M…|—> · Разблокирует: <M…|—>
> Владелец: <роль>

## 1. Цель и границы
## 2. Предусловия
## 3. Решения
## 4. Изменения контрактов
## 5. Задачи
## 6. UI/UX-спецификация
## 7. Тесты и проверки
## 8. Критерии готовности и коммиты
## 9. Риски и откаты
## 10. Трассировка и ссылки
```

Правила наполнения:
1. **Раздел 1** — что этап делает и, главное, чего он **не** делает (границы).
2. **Раздел 3** — только решения этого этапа, с обоснованием в 1–3 предложения; не переписывать ADR из §2.
3. **Раздел 4** — таблицы/поля/эндпоинты/каналы, которые этап добавляет или меняет; должны присутствовать в §4–§6 этого документа (или быть явно новыми с пометкой «новое, требует согласования»).
4. **Раздел 5** — задачи `### T-NN.k. Название` с полями `Файлы:`, `Что сделать:` (нумерованные пункты), `Готово, когда:`, `Оценка:`. Задачи упорядочены по зависимостям; сумма оценок ≈ оценке этапа.
5. **Раздел 6** — только если этап меняет UI: компоненты, состояния, клавиши, поведение; для не-UI этапов писать «Не применимо: этап без изменений UI».
6. **Раздел 7** — таблица «проверка → инструмент → где → ожидаемый результат».
7. **Раздел 8** — чек-лист DoD + список ожидаемых коммитов (Conventional Commits).
8. **Раздел 9** — риски с вероятностью/влиянием и конкретным откатом.
9. **Раздел 10** — ссылки на разделы `TARGET.md`, соседние планы, критерии приёмки.
10. Фрагменты кода/SQL/TS — только короткие (≤ 25 строк), иллюстративные, не дублирующие контракты.
11. Русский язык, деловой стиль, без «todo» без владельца и без «и т.д.» в критериях.

## 11. Порядок работ и Definition of Done

- Этапы выполняются строго M1 → M9 (см. `PLAN.md` §6); внутри этапа задачи — по номерам.
- Перед началом этапа: перечитать `TARGET.md` §6 (соответствующий milestone) и этот документ.
- После этапа: `scripts/test.sh` зелёный, `scripts/ci.sh` собирает артефакт, обновлён `docs/architecture.md` (если менялись контракты), создан/обновлён `docs/acceptance.md` (для M6–M9).
- Definition of Done этапа: все задачи закрыты; тесты §7 зелёные; критерий «Готово, когда» из `TARGET.md` §6 подтверждён вручную на dev-сборке; нет известных регрессий; коммиты по соглашению.
- План этапа считается выполненным, когда Lead обновил статус в `PLAN.md` §6 (колонка «Статус»).

## 12. Требование пользователя, которое обязано быть покрыто

Пользователь отдельно потребовал: **элементы управления для ручной простановки собственных меток по видео и поиск по этим меткам**. Это не «опция», а обязательная часть объёма:

- **M7** обязан содержать полный UI-контур ручных меток: создание (кнопка `＋ метка`, drag по таймлайну, Ctrl+M на позиции плеера, выделение диапазона строк в панели таймингов), редактирование (диалог + drag границ на таймлайне), удаление, цвет, теги метки, заметку, отображение на таймлайне и в панели таймингов, клавиатурные сокращения, undo.
- **M7** обязан содержать поиск по меткам: `scope=annotations`, FTS по `label`+`note`, фильтры `tag:`/цвет/видео, отдельная панель «Метки» со списком и фильтрами, переход из результата поиска к `start_ms` с подсветкой метки на таймлайне.
- **M4** обязан спроектировать `/search` так, чтобы `kind:"annotation"` добавлялся без ломки контракта (scope, поля, сниппеты).
- **M6** обязан обеспечить теги для меток (таблица `annotation_tags`) и поиск `tag:` по меткам.
- **M9** обязан включить горячие клавиши меток и поиска в окно «О клавишах» и в доступность с клавиатуры.

## 13. Глоссарий

| Термин | Значение |
|---|---|
| Сегмент | Фрагмент транскрипции (`segments`), привязан к видео и интервалу. |
| Метка (annotation) | Пользовательский интервал видео с названием, цветом, заметкой и тегами. |
| Аннотация | Синоним метки (в API/БД — `annotations`). |
| Тег | Элемент иерархии пользовательских тегов (`tags`), назначается файлам, сегментам и меткам. |
| Сниппет | Фрагмент текста результата поиска с `<mark>`-подсветкой. |
| Sidecar | Бэкенд-процесс, упакованный PyInstaller и запускаемый Electron. |
| Handshake | Обмен `VL_TOKEN`/`VL_READY` между Electron и sidecar. |
| Watched folder | Корень, добавленный пользователем в отслеживаемые. |

## 14. Файлы планов и владельцы

| Файл | Этап | Владелец |
|---|---|---|
| `PLAN.md` | мастер-план | Lead |
| `plans/00-conventions.md` | контракты | Lead |
| `plans/01-skeleton-m1.md` | M1 скелет | writer-core |
| `plans/02-library-m2.md` | M2 библиотека | writer-core |
| `plans/03-transcription-m3.md` | M3 транскрипция | writer-core |
| `plans/04-search-m4.md` | M4 поиск | writer-search |
| `plans/05-player-timings-m5.md` | M5 плеер/тайминги | writer-search |
| `plans/06-tags-m6.md` | M6 теги | writer-release |
| `plans/07-annotations-m7.md` | M7 метки + поиск по меткам | Lead |
| `plans/08-packaging-m8.md` | M8 упаковка | writer-release |
| `plans/09-polish-m9.md` | M9 полировка | writer-release |
| `plans/10-acceptance-ci.md` | приёмка и CI | writer-search |
