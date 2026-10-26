# Архитектура VideoLessons

## Процессы

```
Electron main (Node) ──spawn──> sidecar: Python 3.11 FastAPI/uvicorn (127.0.0.1, динамический порт)
        │                                   │
        │ preload (contextBridge)            ├── SQLite (WAL) + FTS5: videos/segments/tags/annotations
        ▼                                   ├── ProcessPool/Process(spawn): faster-whisper (CPU INT8)
Renderer: SPA (React), грузится с бэкенда   └── SSE /api/events (прогресс, статусы, изменения)
```

- **A1.** В production SPA отдаётся бэкендом (`http://127.0.0.1:<port>/`), API — same-origin. В dev — Vite (`:5173`) с прокси `/api` → uvicorn (`:8765`).
- **A3.** Handshake: Electron генерирует `VL_TOKEN`, бэкенд слушает `127.0.0.1:0` и печатает `VL_READY:{"port":N}`; Electron ждёт ≤ 15 с, при падении — до 3 рестартов с backoff.
- **A4.** Все `/api/*` требуют `X-VL-Token`; исключения по query-токену: `/api/events` (EventSource) и `/api/videos/{id}/stream` (`<video src>`). Превью — `fetch`+`blob`.
- **A2.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; окно общается с ОС только через `window.vl` (preload), вызываемый из слоя `frontend/src/api/*`.
- **A6.** Транскрипция — отдельный процесс (`multiprocessing.Process`, spawn), FIFO-очередь, прогресс через SSE; отмена — `Event` + terminate; на старте `processing → queued` (crash-recovery).

## Данные

`$VL_DATA_DIR/library.db` (по умолчанию `~/.local/share/VideoLessons/library.db`), `PRAGMA journal_mode=WAL`,
`foreign_keys=ON`. Миграции forward-only (`PRAGMA user_version`), файлы `backend/app/migrations/NNN_*.sql`:

| № | Этап | Содержимое |
|---|---|---|
| 001 | M1 | базовые таблицы (videos, segments, tags, video_tags, segment_tags, annotations, watched_folders) |
| 002 | M1 | поля videos: lang/model/headline/mtime_ms/duplicate_of |
| 003 | M1 | settings, folder_stats + дефолты настроек |
| 004 | M4 | segments_fts (FTS5, external content) + триггеры |
| 005 | M6 | индексы тегов + регистронезависимая уникальность |
| 006 | M7 | annotation_tags (теги меток) |
| 007 | M7 | annotations_fts + updated_at |

## API (префикс `/api`)

health, settings (GET/PATCH), events (SSE), folders, fs/list, videos (list/scan/enqueue/delete/reprocess/cancel/segments/stream/thumb), queue, tags (tree/CRUD/export/import + теги файлов и сегментов), search (`scope=all|files|segments|annotations`, `tag:`/`file:`), annotations (list/create/bulk/get/patch/delete/export/import).
Формат ошибок — `{detail, code}`. Контракты и формы ответов — `plans/00-conventions.md` §4.

## Поиск

`segments_fts` и `annotations_fts` — FTS5 external content (`unicode61 remove_diacritics 2`), триггеры синхронизации.
Запрос пользователя разбирается `utils/fts_query.py` (белый список: слова, кавычки, AND/OR/NOT, `tag:`/`file:`); произвольный
синтаксис FTS5 не пробрасывается. Сниппеты: маркеры → HTML-экранирование → `<mark>`. Ранжирование — `-bm25` с фиксированными весами
(метки: label 2.0 / note 1.0), детерминированный tie-break.

## Сборка и поставка

- Релизный backend собирается **только** в Docker `ubuntu:22.04` (`packaging/docker/Dockerfile.build`, PyInstaller `--onedir`).
- `resources/ffmpeg` (статический ffmpeg/ffprobe, приоритет LGPL) и `resources/models/faster-whisper-small` кладутся в `extraResources`.
- `electron-builder` собирает `.deb` (SUID `chrome-sandbox` через `afterInstall`) и `.AppImage`.
- Рантайм не делает сетевых запросов, кроме `127.0.0.1`.
