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
| 008 | M11 | recordings (сессии записи экрана/окна, FK на videos) |
| 009 | M12 | segment_embeddings (BLOB float32, 384d, каскад от segments) |
| 010 | M13 | model_downloads (состояние загрузок моделей) + videos.error_code |
| 011 | M14 | summary_chunks / summary_levels (per-model кэш) / summary_jobs |

## API (префикс `/api`)

health, settings (GET/PATCH), events (SSE), folders, fs/list, videos (list/scan/enqueue/delete/reprocess/cancel/segments/stream/thumb), videos/transfer (move/copy в папку + история адресатов — V5), queue, tags (tree/CRUD/export/import + теги файлов и сегментов), search (`scope=all|files|segments|annotations`, `mode=fts|semantic|hybrid`, `tag:`/`file:`), search/semantic (status/reindex), annotations (list/create/bulk/get/patch/delete/export/import), recordings (M11), models (GET, download/cancel/delete/import — M13), videos/{id}/summary (GET/POST/DELETE — M14).
Формат ошибок — `{detail, code}`. Контракты и формы ответов — `plans/00-conventions.md` §4.

## Автопревью несовместимых форматов

Chromium не декодирует HEVC/10-bit и не все контейнеры. `services/media_info.py` определяет кодеки ffprobe;
`services/preview.py` выбирает режим:

| Режим | Когда | Действие ffmpeg |
|---|---|---|
| `direct` | H.264/VP9/AV1 8-bit в MP4/WebM + AAC/MP3/Opus/Vorbis | оригинал через `/api/videos/{id}/stream` |
| `remux` | видео-кодек браузерный, контейнер нет | `-c:v copy -c:a aac` → MP4 (быстро) |
| `transcode` | HEVC/MPEG-4/10-bit и т.п. | `libx264 veryfast crf23 yuv420p`, 720p для >720p, AAC stereo |

Эндпоинты: `GET /api/videos/{id}/playback` (план и состояние), `POST /api/videos/{id}/prepare-preview`
(запуск фоновой задачи, прогресс через SSE `video.preview` и опрос), `GET /api/videos/{id}/preview`
(Range-стриминг готового MP4), `POST /api/maintenance/clear-preview-cache`.
Кэш: `$VL_DATA_DIR/cache/preview/`, ключ `{id}_{mtime}_{mode}`; старая версия файла удаляется при пересборке.

## Запись экрана (M11)

```
RecordDialog (React)
  ├─ vl.getCaptureSources() ──IPC──> main.desktopCapturer.getSources({types:['screen','window']})
  │                                    → [{id, name, type, thumbnail_data_url}]
  ├─ navigator.mediaDevices.getUserMedia(desktop)  → video track
  ├─ navigator.mediaDevices.getUserMedia(mic)      → audio track (если выбран микрофон)
  └─ MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp9,opus'}) — чанки ≈1 с
        → POST /api/recordings/{id}/chunks (raw-тело, последовательно)
backend RecordingManager
  ├─ POST /api/recordings                     → сессия; опц. ffmpeg -f pulse <sink>.monitor
  │                                              → tmp/<id>.audio.ogg (системный звук)
  ├─ POST /api/recordings/{id}/pause|resume   → MediaRecorder в renderer + SIGSTOP/SIGCONT ffmpeg
  └─ POST /api/recordings/{id}/finish
        ffmpeg -c copy (+ amix системного звука) → $VL_DATA_DIR/recordings/rec-YYYYMMDD-HHMMSS-<8hex>.webm
        → scanner.upsert_file() в videos(status='pending') → INSERT recordings
        → SSE recording.finished / video.status → встроенный плеер (playback_mode='direct')
```

**Живой предпросмотр.** Тот же desktop-`MediaStream`, который получает `MediaRecorder`, отдаётся в
`recordStore.previewStream`; компонент `RecordingPreview` показывает его в основной панели видео через
`<video muted autoPlay playsInline>` с `srcObject` — второй захват не создаётся, дополнительного
перекодирования нет. Звук предпросмотра выключен (иначе микрофон даёт эхо); системный звук в этот поток
не входит. При старте записи встроенный плеер ставится на паузу, после finish предпросмотр уступает
место сохранённому видео.

**Почему WebM (VP9 + Opus).** Chromium в Electron декодирует VP9 и Opus нативно, поэтому запись играется
встроенным плеером без внешних программ и без конвертации. VP9 экономичнее VP8/H.264 на низких битрейтах,
Opus 96–128 кбит/с. `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1…')` в Chromium-сборках Electron
возвращает `false` — MP4 потребовал бы пострекодирования. `services/media_info.py` считает `webm/vp9/opus`
режимом `direct`. Fallback выбора mime: `vp9,opus` → `vp8,opus` → `video/webm`.

**API** (все запросы с `X-VL-Token`, ошибки `{detail, code}`):

| Метод | Path | Назначение |
|---|---|---|
| GET | `/api/recordings/capabilities` | `{system_audio:{available,detail}, max_chunk_bytes}` |
| POST | `/api/recordings` | старт сессии → `201 {recording_id, system_audio}` |
| POST | `/api/recordings/{id}/chunks` | raw `application/octet-stream`, ≤ 32 МиБ → `202 {bytes}` |
| POST | `/api/recordings/{id}/pause`, `/resume` | пауза/продолжение → `204`, идемпотентно |
| POST | `/api/recordings/{id}/finish` | `201 {video_id,title,duration_ms,size_bytes,path,playback_mode}` |
| POST | `/api/recordings/{id}/cancel` | удалить сессию и временные файлы → `204` |
| GET | `/api/recordings/{id}` | состояние сессии (диагностика/тесты) |

Коды ошибок: `invalid_payload` 400, `invalid_source` 400, `invalid_mime` 400, `recording_not_found` 404,
`recording_finished` 409, `recording_empty` 400, `chunk_too_large` 413, `system_audio_unavailable` 409,
`finalize_failed` 500. После финализации публикуются SSE `recording.finished` и `video.status`
(`status: added`), как после скана.

**Данные.** Миграция `008_recordings.sql`:

```sql
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,                 -- uuid hex (32 символа) — id сессии
  video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,           -- 'screen' | 'window'
  source_title TEXT, mime_type TEXT NOT NULL,
  system_audio INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER, size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Каталоги: `$VL_DATA_DIR/recordings/` — финальные WebM; `$VL_DATA_DIR/tmp/recordings/` — `<id>.webm.part`
и `<id>.audio.ogg`, каталог очищается при старте backend (сессии после аварийного завершения).
Финализация: закрыть приём чанков → ffmpeg (таймаут 180 с; при ошибке — fallback «скопировать part как есть»)
→ `os.replace` в `recordings/` → `scanner.upsert_file` (`pending`/`duplicate`) → заголовок
(из запроса или `_default_title`: «Запись экрана ДД.ММ.ГГГГ ЧЧ:ММ» / «Запись окна …») → строка `recordings` → SSE.

**Системный звук** (`services/system_audio.py`). Доступность: Linux + `pactl` в PATH + sink
(`pactl get-default-sink` или первый из `pactl list short sinks`), источник — `<sink>.monitor`.
Два маршрута захвата: 1) `pulse` — системный ffmpeg с pulse-демаксером:
`ffmpeg -f pulse -i <monitor> -c:a libopus -b:a 128k -f ogg`; 2) `parec` — `parec` (пакет
`pulseaudio-utils`) пишет PCM monitor-звука в pipe, встроенный ffmpeg кодирует Ogg/Opus.
`parec`-маршрут нужен потому, что **поставляемый статический ffmpeg собран без pulse-демаксера**
(encoder `libopus` обязателен). Пауза/продолжение — `SIGSTOP`/`SIGCONT` дочернего процесса (ffmpeg или parec),
остановка — `q` в stdin с последующим terminate (≤ 3 с), перед сигналом снимается SIGSTOP.
Микрофон пишется прямо в WebM (точная синхронизация), системный звук подмешивается `amix` при финализации —
возможен сдвиг ~0,1–0,3 с.

**Electron и безопасность.** Захват — только в main (`desktopCapturer`), renderer получает источники через
`window.vl.getCaptureSources()` (IPC `vl:capture:sources`), затем `getUserMedia` в renderer.
`hardenSession()` (`setPermissionRequestHandler`) разрешает `media`/`display-capture` только для origin
`http://127.0.0.1:*`/`http://localhost:*`, отказы логируются. В обычном браузере (без Electron)
`getCaptureSources` возвращает `[]`, кнопка записи объясняет недоступность.

**Ограничения.** Системный звук — только Linux/PulseAudio/PipeWire; Wayland — через xdg-desktop-portal/XWayland;
при аварийном завершении приложения сессия теряется; автотранскрипция не запускается (toast-действие «Обработать»).
Тесты: `backend/tests/test_m11_recordings.py`, vitest `lib/recording.test.ts`/`state/recordStore.test.ts`,
e2e `e2e/recording.spec.ts` (mocked capture, реальный upload→finish→playback).

## Внешний плеер (V3)

`services/external_player.py` запускает mpv/VLC/xdg-open и синхронизирует mpv через UNIX-сокет
(`--input-ipc-server`): команды `observe_property` (time-pos/duration/pause/volume), `seek`, `cycle pause`,
`set_property`. Состояние сессии отдаётся `GET /api/external/status` (опрос 600 мс) и SSE `external.state`.
Метки передаются как главы (`--chapters-file`, OGM) и субтитры (`.ass`, цвет из `annotations.color`);
для VLC — только `--start-time`/`--sub-file`; системный плеер — без синхронизации.
Настройки: `external.player` (mpv/vlc/system), `external.player_path`, `external.policy` (ask/always/never),
`external.pass_marks`. Для безопасности mpv запускается с `--no-config --load-scripts=no --ytdl=no`.
Плеер стартует в отдельной сессии процесса и завершается при закрытии приложения.

## Поиск

`segments_fts` и `annotations_fts` — FTS5 external content (`unicode61 remove_diacritics 2`), триггеры синхронизации.
Запрос пользователя разбирается `utils/fts_query.py` (белый список: слова, кавычки, AND/OR/NOT, `tag:`/`file:`); произвольный
синтаксис FTS5 не пробрасывается. Сниппеты: маркеры → HTML-экранирование → `<mark>`. Ранжирование — `-bm25` с фиксированными весами
(метки: label 2.0 / note 1.0), детерминированный tie-break.

## Семантический поиск (M12)

```
TranscriptionQueue._store_result (status=done, commit)
  └─ SemanticIndexManager.index_video(video_id)          # sync, ошибки → warning (видео остаётся done)
       └─ tokenizer(passage: …) → onnxruntime → mean-pool + L2 → UPSERT segment_embeddings
GET /api/search?mode=fts|semantic|hybrid
  ├─ FTS5 (files/segments/annotations)                  # как в M4/M7
  ├─ semantic: numpy-косинус по кэшу матрицы векторов   # только scope all|segments
  └─ hybrid: Reciprocal Rank Fusion k=60 → дедуп → сортировка
```

**Модель.** `intfloat/multilingual-e5-small` (ONNX int8-экспорт `Xenova/multilingual-e5-small`), 384 измерения,
токенайзер `tokenizers` (JSON). Инференс — ONNX Runtime CPU: mean-pooling по `last_hidden_state` с attention mask,
L2-нормализация, префиксы e5 `query: ` / `passage: `, `max_length=512`, батчи по 32, потоки `VL_EMBED_THREADS`
(default 2). Модель загружается лениво; каталог — `resources/models/multilingual-e5-small-onnx/`
(`VL_EMBEDDING_MODEL_DIR`), ~130 МБ (113 МБ `onnx/model_quantized.onnx` + 17 МБ `tokenizer.json`).
`scripts/fetch-embed-model.sh` скачивает файлы из HF один раз (идемпотентно); рантайм — офлайн.

**Данные.** Миграция `009_segment_embeddings.sql` (версия схемы 9):

```sql
CREATE TABLE segment_embeddings (
  segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,              -- float32, L2-нормированный, dim = length(vector)/4
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Инварианты: `vector` — L2-нормированный float32 (384·4 = 1536 Б ≈ 1,5 КБ/сегмент; ~150 КБ на 10-мин видео);
каскадное удаление вместе с сегментами (повторная транскрипция/удаление видео очищает вектора);
`model` позволяет хранить векторы разных моделей и переиндексировать без смешивания.

**Почему без sqlite-vec.** Вектора — BLOB в обычной таблице, сравнение — `numpy`-матрица `E @ q` с кэшем в памяти
(инвалидация по revision при индексации). Это не добавляет новых бинарных зависимостей и хуков PyInstaller
(важно для поставки), а для локальной библиотеки до ~10⁵ сегментов даёт миллисекунды. При росте библиотеки
предусмотрено развитие через sqlite-vec; кандидаты заранее сужаются фильтрами (`video_id`, теги, `file:`),
top-N ограничен 500.

**Индексация.** После транскрипции — `queue._store_result → index_video` (синхронно, ошибки логируются,
статус видео не меняется). При старте backend, если `VL_EMBED_AUTOINDEX != 0` (по умолчанию включено),
фоновый поток доиндексирует сегменты без актуальной модели. `POST /api/search/semantic/reindex {force?:bool}`
запускает полную переиндексацию в отдельном потоке (один одновременно) → `202 {state:"indexing", ...status}`.
Прогресс — SSE `embedding.progress {indexed,total,percent}` и `embedding.state {state,detail}`.
Запись в БД — в отдельных соединениях, состояние защищено RLock.

**API.**
`GET /api/search/semantic/status` → `{available, model, dim, indexed_segments, total_segments, indexing, autoindex, detail}`;
`POST /api/search/semantic/reindex` → `202 {state, ...status}`.
`GET /api/search?...&mode=fts|semantic|hybrid` (API default — `fts` для обратной совместимости, UI default — `hybrid`):
в ответе `query.mode`, `query.mode_used` (фактический), `query.semantic` (полный статус), `query.took_ms`;
ошибка `invalid_mode` — 422. Семантика — только `scope in {all, segments}`; для `files/annotations` или при
`available=false` — `mode_used="fts"` (грациозная деградация, приложение работает без модели).

**Гибрид (RRF).** Для каждой выдачи (FTS и семантической) элемент получает `1/(k+rank+1)`, `k=60`;
дедупликация по `(kind, id)`; при совпадении FTS-item дополняется `semantic=True`; сортировка
`(-score, KIND_ORDER, video_id, start_ms)`; `total` — число уникальных. Пример: запрос, который находит
сегмент и лексически, и семантически на 1-м месте обеих выдач, получает `2/(60+1) ≈ 0.0328`.

**Производительность (замеры на dev-машине, реальная модель).** Загрузка модели + первый encode — ~0,53 с;
тёплый encode — ~1,2 мс; поиск по 4 сегментам — 1,3–1,5 мс (первый после загрузки — ~1,8 мс); индексация
4 сегментов (с загрузкой модели) — ~0,6 с. Для сравнения: на 64 сегментах план фиксирует ~0,06 с индексации.

**Поставка.** `resources/models/multilingual-e5-small-onnx` (~130 МБ) попадает в `extraResources`/`.deb`
(размер `.deb` растёт примерно на столько же: модель Whisper `tiny` уже в dev-пакете; релизная — `small`).
`backend/requirements-ml.txt` явно содержит `onnxruntime`, `tokenizers`, `numpy`; `packaging/backend.spec`
включает `onnxruntime`/`numpy` через `collect_all`. Лицензии — в `resources/THIRD-PARTY-NOTICES.md`
(intfloat/multilingual-e5-small — MIT, ONNX-экспорт Xenova — MIT).

## Менеджер моделей (M13)

- Реестр — `backend/app/model_manifest.json`: whisper tiny/base/small/medium, e5, `summary-lfm2.5-350m`
  (KoarAI LFM2.5-350M-Thinking, значок «Рекомендованная», default) и `summary-qwen2.5-0.5b`
  (Qwen2.5-0.5B-Instruct, «Альтернатива»). У каждой записи — pinned revision, размеры, SHA-256 (для LFS),
  лицензия, `recommended/default`, `meta.supports_thinking`.
- Хранение: `$VL_DATA_DIR/models/<local_dir>/` + `.installed.json`; legacy `$VL_RESOURCES_DIR/models`
  читается как `bundled` (read-only). Разрешение путей — `services/model_resolver.py` (data → resources).
- `services/model_store.py`: один worker-thread, httpx streaming с прогрессом, Range-докачка, проверка
  SHA-256/размера, атомарная установка, импорт каталога/`.zip`/`.tar.gz` с защитой от traversal, проверка
  свободного места (×1.05 + 200 МиБ), single-flight на модель, офлайн (`models.offline`/`VL_OFFLINE=1`),
  зеркало (`models.endpoint`/`VL_MODELS_ENDPOINT`), SSE `model.progress`/`model.state`.
- UI «Настройки → Модели»: обе summary-модели можно установить одновременно; активная выбирается
  в «Саммари» (`summary.model`) без повторной загрузки; кэш саммари per-model.
- Сеть: только по явному действию «Скачать» (исключение из `TARGET.md` §10/A11); импорт модели работает без сети.

## Саммари транскрибации (M14, rev2)

- `services/llm/llama_cli.py` — spawn `resources/llama/llama-cli` (pinned b11669, MIT):
  `-sys`/`-p`/`-st`/`-rea off`, GBNF `--grammar-file` (json-schema в сборке не работает), timeout/kill,
  вырезание `<think>`; fake-режим `VL_SUMMARY_FAKE=1`.
- **Иерархическая декомпозиция** (`services/summary/tree.py`, `pipeline.py`): сначала OUTLINE всего текста
  (о чём видео + логические блоки); если текст не влезает в контекст — непрерывные чанки по бюджету токенов
  + MERGE chunk-саммари (верхнеуровневое саммари строится всегда). Затем рекурсивный SPLIT каждого блока:
  `{split:false}` либо подблоки по смыслу; рекурсия до отдельных строк (листья ≤2 строк, `MAX_DEPTH=8`,
  лимиты узлов/вызовов), недостающий контекст блока — чанки+OUTLINE внутри блока. Узлы — `summary_nodes`
  (node_id `0`, `0.1`, …), уровни материализуются по фактической глубине.
- Уровни: `level 1` — самый подробный (листья), `level max_level` — один корневой блок с `root_summary`;
  метки «Подробно/Темы/Обзор/…». Кэш per-model (`source_hash`+`model`+`prompt_version`), инвалидация,
  crash-recovery; `SummaryManager` (один worker, compute-gate с транскрипцией, SSE
  `summary.progress` `outline|splitting|summarizing`, `summary.state`).
- API `GET/POST/DELETE /api/videos/{id}/summary` → `{state,max_level,levels,root_summary,…}`; UI — динамическая
  шкала `DetailScale`: число детентов = `max_level+1` (0 «Дословно» … max_level), метки из API; блоки с
  заголовками/таймкодами, seek, активный блок.

## Сборка и поставка

- Релизный backend собирается **только** в Docker `ubuntu:22.04` (`packaging/docker/Dockerfile.build`, PyInstaller `--onedir`).
- `resources/ffmpeg` (статический ffmpeg/ffprobe, приоритет LGPL) и `resources/llama` (pinned CPU-runtime
  llama.cpp, MIT) кладутся в `extraResources`. **Модели в бандл не входят** (M13): пользователь скачивает
  их из «Настройки → Модели» в `$VL_DATA_DIR/models`; legacy `resources/models` читается как `bundled`.
- **Примечание к релизу (M11):** статический ffmpeg поставляется без pulse-демаксера, поэтому системный звук
  записи на Linux идёт через `parec` (`pulseaudio-utils`) → PCM → встроенный ffmpeg (`libopus`). В `.deb`
  добавлен `Recommends: pulseaudio-utils` (`packaging/electron-builder.yml`, `scripts/build-deb.sh`) —
  пакет ставится по умолчанию, но приложение работает и без него (опция системного звука будет недоступна);
  на Windows/macOS системный звук не поддерживается.
- `electron-builder` собирает `.deb` (дефолтный postinst: `/usr/bin/videolessons` через update-alternatives, `chrome-sandbox` SUID/0755 по наличию user namespaces, AppArmor-профиль на Ubuntu 24+) и `.AppImage`.
  Конфиг — `packaging/electron-builder.yml`; он лежит вне корня проекта, поэтому запуск только
  с `--config packaging/electron-builder.yml` (`npm run dist` / `npm run dist:appimage`).
  В `package.json` **не должно быть** ключа `build`: electron-builder при его наличии берёт
  конфиг из него и пропускает файл, из-за чего `extraResources` теряются, а в `app.asar`
  попадает весь репозиторий.
- Раскладка `extraResources` (её ожидает `electron/backend.ts` и `backend/app/config.py`):
  `resources/backend/vl-backend` (файл sidecar) + `resources/backend/_internal/`,
  `resources/frontend/dist/`, `resources/ffmpeg/{ffmpeg,ffprobe}`, `resources/llama/` (моделей нет).
  `from` — каталог, поэтому `to` указывается без лишнего уровня: `to: backend`
  (а не `backend/vl-backend`), иначе sidecar окажется в `resources/backend/vl-backend/vl-backend`
  и `spawn` упадёт с `EACCES`. `scripts/after-pack.js` выставляет бит исполнения и падает,
  если backend/ffmpeg/SPA/llama-runtime не попали в пакет и если в пакет случайно попал `resources/models`;
  после сборки `scripts/check-artifacts.sh` (раскладка, отсутствие моделей, размеры) и
  `scripts/smoke-sidecar.sh` проверяют реальный запуск sidecar.
- Sidecar — PyInstaller `--onedir` + `multiprocessing` (spawn) для транскрипции:
  `backend/pyinstaller_entry.py` обязан вызывать `multiprocessing.freeze_support()` до `run()`,
  иначе дочерний процесс `vl-backend --multiprocessing-fork` заново исполнит entrypoint и
  поднимет второй backend (рекурсивная лавина процессов, транскрипция не работает).
  Дополнительно `electron/backend.ts` игнорирует поздний `VL_READY` от дочерних процессов.
- Рантайм не делает фоновых сетевых запросов: единственный egress — HTTPS-загрузка модели по явному
  действию пользователя (M13); импорт из файла и офлайн-режим сети не требуют.
