# 11. Запись экрана / окна (аудио+видео)

> Статус: **реализован** (M11; тесты и доказательства — `docs/acceptance.md`, `PLAN.md` §15).
> Новые контракты (API, IPC, миграция, формат хранения) обязательны для всех исполнителей.
> При противоречии с `plans/00-conventions.md` — прав этот файл, а `plans/00` правит Lead.

## 1. Задача и решение

Пользователь: **добавить возможность записи всего экрана или выбранного окна (аудио+видео)**;
формат хранения — **желательно без внешнего плеера и с небольшим размером**.

### Решение (зафиксировано)

| Аспект | Решение | Обоснование |
|---|---|---|
| Захват видео | Electron main: `desktopCapturer.getSources({types:['screen','window']})` → IPC → renderer `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})` | Штатный путь Electron, выбор источника с миниатюрами, не нужны внешние утилиты |
| Кодек/контейнер | **WebM: VP9 + Opus** (fallback VP8+Opus, затем `video/webm`) | Нативно декодируется встроенным Chromium-плеером → **внешний плеер не нужен**; VP9 экономичнее VP8/H.264 при низких битрейтах, Opus 96–128 кбит/с; `media_info` уже считает `webm/vp9/opus` режимом `direct` |
| Почему не MP4 | В Chromium-сборках Electron `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1…')` = `false` (проверено на окружении); MP4 потребовал бы пострекодирования | Не тратим ресурсы и не теряем мгновенную доступность |
| Захват звука | **Микрофон** — `getUserMedia({audio})` в renderer (пишется прямо в WebM, идеальная синхронизация). **Системный звук** — backend `ffmpeg -f pulse -i <monitor>` (PulseAudio/PipeWire, Linux) в отдельный Ogg/Opus, смешивается при финализации | Системный звук через Chromium на Linux не поддержан; ffmpeg уже входит в поставку |
| Размер | Пресеты качества: `low` 720p≈1.5 Мбит/с, `standard` 1080p≈3 Мбит/с, `high` исходное≈6 Мбит/с; Opus 96–128 кбит/с | ≈11/22/45 МБ на минуту; пользователь видит оценку в диалоге |
| Хранение | `$VL_DATA_DIR/recordings/<...>.webm` (финальный файл), `$VL_DATA_DIR/tmp/recordings/<session>.*` (временные) | Рядом с БД/кэшем, чистится при старте |
| Библиотека | После финализации запись автоматически регистрируется в `videos` (`status='pending'`, title, duration, size, sha256), появляется в списке и играется встроенным плеером | Единый конвейер: превью, метки, теги, транскрипция доступны как обычному видео |

Ограничения (честно документируются в UI/доках):
- системный звук — только Linux с PulseAudio/PipeWire и утилитой `pactl`; на Windows/macOS опция недоступна (там остаётся микрофон);
- Wayland: захват окна возможен через xdg-desktop-portal/ Electron; при XWayland работает как X11. При невозможности источника UI показывает ошибку;
- синхронизация системного звука с видео может отличаться на ~0.1–0.3 с (микрофон в WebM синхронизирован точно);
- при аварийном завершении приложения сессия теряется (временные файлы удаляются при следующем старте); при закрытии окна во время записи показывается предупреждение `beforeunload`.

## 2. Поток данных

```
RecordDialog (React)
  ├─ vl.getCaptureSources() ──IPC──> main.desktopCapturer.getSources() → [{id,name,type,thumbnail}]
  ├─ navigator.mediaDevices.getUserMedia(desktop)  → video track
  ├─ navigator.mediaDevices.getUserMedia(mic)      → audio track (если выбран микрофон)
  ├─ MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond})
  │     ondataavailable(≈1 c) → api.uploadRecordingChunk(id, blob)   (последовательно)
  ▼
backend RecordingManager
  ├─ POST /api/recordings                      → сессия, (опц.) старт ffmpeg системного звука
  ├─ POST /api/recordings/{id}/chunks (raw)    → append в tmp/<id>.webm.part
  ├─ POST /api/recordings/{id}/pause|resume    → MediaRecorder + SIGSTOP/SIGCONT ffmpeg
  └─ POST /api/recordings/{id}/finish
        ffmpeg -c copy (+ amix с системным звуком при наличии) → recordings/<name>.webm
        → probe/upsert в videos (status pending) → INSERT recordings → SSE recording.finished
        → {video_id, title, duration_ms, size_bytes, playback_mode}
```

## 3. Данные

### 3.1. Каталоги

`Config` дополняется:
- `recordings_dir = data_dir / "recordings"` — финальные записи;
- `recording_tmp_dir = tmp_dir / "recordings"` — `.webm.part`, `.audio.ogg`;
оба создаются в `ensure_dirs()`. При старте backend временный каталог очищается (аварийные сессии).

### 3.2. Миграция `backend/app/migrations/008_recordings.sql`

```sql
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,                 -- uuid hex сессии (32 символа)
  video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,           -- 'screen' | 'window'
  source_title TEXT,                   -- имя экрана/окна (для истории)
  mime_type TEXT NOT NULL,             -- фактический mime MediaRecorder
  system_audio INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recordings_video ON recordings(video_id);
```

## 4. API (дополнение к конвенциям)

Все ответы — JSON, ошибки `{detail, code}` (как в `00-conventions.md` §4). Все запросы с `X-VL-Token`.

| Метод | Path | Назначение |
|---|---|---|
| GET | `/api/recordings/capabilities` | `{system_audio:{available:bool,detail:str\|null}, max_chunk_bytes:int}` |
| POST | `/api/recordings` | `{source_kind, source_title, title?, mime_type, system_audio}` → `201 {recording_id, system_audio:{active,detail}}` |
| POST | `/api/recordings/{id}/chunks` | тело raw (`application/octet-stream`), ≤ `max_chunk_bytes` (32 МиБ) → `202 {bytes}` |
| POST | `/api/recordings/{id}/pause` | пауза системного звука → `204`; идемпотентно |
| POST | `/api/recordings/{id}/resume` | продолжение → `204`; идемпотентно |
| POST | `/api/recordings/{id}/finish` | `{duration_ms?, width?, height?}` → `201 {video_id, title, duration_ms, size_bytes, path, playback_mode}` |
| POST | `/api/recordings/{id}/cancel` | удалить сессию и временные файлы → `204`; идемпотентно |
| GET | `/api/recordings/{id}` | `{recording_id,state,bytes,duration_ms,system_audio}` (диагностика/тесты) |

Коды ошибок: `invalid_payload` 400, `invalid_source` 400, `invalid_mime` 400, `recording_not_found` 404,
`recording_finished` 409, `recording_empty` 400, `chunk_too_large` 413, `system_audio_unavailable` 409,
`finalize_failed` 500.

SSE: после финализации публикуются `recording.finished {video_id,title,path,duration_ms,size_bytes}`
и `video.status {video_id,status:'added',path}` (как после скана).

Валидация: `source_kind ∈ {screen,window}`; `mime_type` начинается с `video/webm`; `title` ≤ 200 символов;
`source_title` ≤ 300; `recording_id` — `^[0-9a-f]{32}$`; пустой чанк → `invalid_chunk` 400.

### 4.1. Финализация (backend `services/recording.py`)

1. Закрыть приём чанков (state `finalizing`), остановить системный звук (`q` в stdin ffmpeg, затем terminate) и дождаться.
2. Проверить `tmp/<id>.webm.part` не пуст → иначе `recording_empty`.
3. Команда ffmpeg (таймаут 180 с):
   - видео+микрофон+системный звук: `-i part -i audio.ogg -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a libopus -b:a 128k -shortest out.webm`;
   - только системный звук: `-i part -i audio.ogg -map 0:v -map 1:a -c copy -shortest out.webm`;
   - без системного: `-i part -c copy out.webm`.
4. `os.replace` в `recordings/rec-YYYYMMDD-HHMMSS-<8hex>.webm`; при ошибке ffmpeg — fallback: скопировать part как есть
   (файл всё равно играется, длительность 0); ошибка не фатальна, но пишется в лог.
5. `scanner.upsert_file(conn, config, final_path)` → `videos` (`pending`/`duplicate`), затем
   `UPDATE videos SET title=?` (title из запроса или «Запись экрана/окна DD.MM.YYYY HH:MM»).
6. `INSERT INTO recordings(...)`; `bus.publish_threadsafe(...)`.
7. Ответ: `playback_mode` считается через `media_info.probe_streams(...).mode` (webm/vp9/opus → `direct`).

### 4.2. Системный звук (`services/system_audio.py`)

- доступность: Linux + `pactl` в PATH + успешный `pactl get-default-sink` (или первый sink из `pactl list short sinks`);
  источник = `<sink>.monitor`; не найдено → `available=false, detail=<причина>`.
- старт: `ffmpeg -hide_banner -loglevel error -nostdin -f pulse -i <monitor> -c:a libopus -b:a 128k -f ogg <tmp>/<id>.audio.ogg`,
  ждём появления непустого файла ≤ 2 с; при неудаче — `active=false, detail=<stderr>` (запись продолжается без системного звука).
- пауза/продолжение: `SIGSTOP`/`SIGCONT` (POSIX; на остальных ОС система недоступна).
- остановка: `q` → ожидание ≤ 3 с → `terminate()`/`kill()`; удалить файл после микса.
- класс потокобезопасен (lock), `stop_all()` при завершении backend.

Эндпоинты `recording` в `main.py`: `app.state.recording = RecordingManager(...)`,
`include_router(recordings.router)`; в lifespan `finally` — `recording.shutdown()`; на старте — очистка tmp.

## 5. Electron (main/preload/IPC)

`electron/ipc-channels.ts` — новые каналы:

```ts
captureSources: 'vl:capture:sources',
```

Тип ответа (дублируется в `frontend/src/api/types.ts`):

```ts
export interface CaptureSource {
  id: string;                 // screen:0:0 | window:12345
  name: string;
  type: 'screen' | 'window';
  display_id?: string;
  thumbnail_data_url: string; // PNG data URL (320×180)
}
```

`main.ts`:
- `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{width:320,height:180}, fetchWindowIcons:false})`,
  маппинг: `type = id.startsWith('screen:') ? 'screen' : 'window'`, `thumbnail.toDataURL()`;
- обработчик `ipcMain.handle(IPC.captureSources, ...)`;
- `hardenSession()`: `session.defaultSession.setPermissionRequestHandler` — для `media`/`display-capture`
  разрешать только origin `http://127.0.0.1:*`/`http://localhost:*`, для прочих permission поведение прежнее (разрешать);
  отказы логировать. Это не ломает fullscreen/clipboard.
`preload.ts`/`types.ts VLApi`/`frontend/src/api/electron.ts` — `getCaptureSources(): Promise<CaptureSource[]>`;
browser-fallback возвращает `[]` (в браузере запись недоступна, кнопка объясняет это).

## 6. Frontend

### 6.1. Файлы

| Файл | Содержимое |
|---|---|
| `frontend/src/lib/recording.ts` | пресеты качества, `pickMimeType`, `desktopVideoConstraints`, `microphoneConstraints`, `formatElapsed`, `approxSize`, типы `RecordingQuality`/`RecordingAudioMode` |
| `frontend/src/state/recordStore.ts` | zustand-конечный автомат записи (см. 6.2) |
| `frontend/src/components/recording/RecordDialog.tsx(.css)` | модальный диалог: источники (экран/окно, миниатюры), звук, качество, название, старт |
| `frontend/src/components/recording/RecorderBar.tsx(.css)` | плавающая панель активной записи: таймер, пауза/продолжить, сохранить, отменить (+подтверждение) |
| `frontend/src/components/recording/RecordingPreview.tsx(.css)` | live-предпросмотр захвата в основной панели видео: `<video muted autoPlay playsInline>` + `srcObject` из `previewStream`, REC-бейдж/таймер/имя источника, оверлеи «Подготовка…/Сохранение…/Пауза» |
| `frontend/src/components/Toolbar.tsx` | кнопка `⏺ Запись` (aria-label «Запись экрана»), disabled при активной записи/недоступности |
| `frontend/src/App.tsx` | рендер `<RecordDialog/>` и `<RecorderBar/>` |
| `frontend/src/lib/i18n/ru.json` | ключи `recording.*` |
| `frontend/src/api/client.ts` | `recordingCapabilities/startRecording/uploadRecordingChunk/pauseRecording/resumeRecording/finishRecording/cancelRecording` |
| `frontend/src/api/types.ts` | `CaptureSource`, `RecordingCapabilities`, `StartRecordingPayload/Response`, `FinishRecordingPayload/Response` |
| тесты | `lib/recording.test.ts`, `state/recordStore.test.ts`, `components/recording/RecordDialog.test.tsx` |

### 6.2. Контракт `recordStore`

```ts
type RecordStatus = 'idle' | 'preparing' | 'recording' | 'paused' | 'finalizing' | 'error';
interface RecordStoreState {
  dialogOpen: boolean;
  status: RecordStatus;
  error: string | null;
  sources: CaptureSource[];
  sourcesLoading: boolean;
  capabilities: RecordingCapabilities | null;
  audioInputs: { device_id: string; label: string }[];
  selectedSourceId: string | null;
  audioMode: 'none' | 'mic' | 'system' | 'mic_system';
  micDeviceId: string | null;
  quality: RecordingQuality;
  title: string;
  elapsedMs: number;        // активное время без пауз
  bytesSent: number;
  recordingId: string | null;
  lastVideoId: number | null;
  previewStream: MediaStream | null;   // desktop-поток для live-предпросмотра в панели видео
  openDialog(): void; closeDialog(): void;
  loadSources(): Promise<void>;
  setSelectedSource(id: string): void;
  setAudioMode(mode): void; setMicDeviceId(id: string | null): void;
  setQuality(q): void; setTitle(t: string): void;
  start(): Promise<void>; pause(): Promise<void>; resume(): Promise<void>;
  stop(): Promise<{ videoId: number; title: string; durationMs: number; sizeBytes: number; playbackMode: string } | null>;
  cancel(): Promise<void>; reset(): void;
}
```

Правила:
- `start()`: `preparing` → `api.recordingCapabilities` (если ещё нет) → `api.startRecording` (backend-сессия) →
  desktop `getUserMedia` → mic `getUserMedia` при `mic*` → `MediaRecorder(stream, timeslice=1000)` → `recording`.
  Ошибки: cleanup всех потоков, `api.cancelRecording` (best effort), `status='error'`, `error=<текст>`.
  Если режим требует системный звук, а `system_audio.active=false`: `system` → прервать с ошибкой;
  `mic_system` → продолжить с предупреждением (`error` не выставлять; предупреждение — в `RecorderBar` через `capabilities`/toast).
- `ondataavailable` → последовательная очередь `api.uploadRecordingChunk` (порядок байт обязателен; при обрыве — до 2 попыток,
  затем аварийное завершение с ошибкой). `bytesSent` обновляется.
- таймер `elapsedMs` — сумма активных интервалов (без пауз).
- `pause/resume`: MediaRecorder + backend (системный звук); идемпотентно.
- `stop()`: `finalizing` → `recorder.stop()` → дождаться `onstop` и очередь загрузки → `api.finishRecording(recordingId, {duration_ms})`
  → cleanup → `idle`, `lastVideoId`, вернуть данные (UI: toast + refresh + открыть видео).
- `cancel()`: остановить без finish, `api.cancelRecording`, cleanup → `idle`.
- `previewStream`: после старта — desktop-`MediaStream` (тот же, что пишется); очищается (`null`) в
  `stop/cancel/error/reset`; компонент `RecordingPreview` подключает его к `<video>` через `srcObject`.
- `reset()`: cleanup + дефолтные значения (источник/режим звука по доступности, пресет из `localStorage`).
- настройки (качество, режим звука, micDeviceId) сохраняются в `localStorage` (`vl.recording.*`), доступность проверяется заново.
- при активной записи `beforeunload` предупреждает (обработчик в `RecorderBar`).
- `openDialog()` перезагружает источники (они меняются), capabilities и аудиоустройства; `stop()` не закрывает диалог.

### 6.3. UI-требования

- Диалог: `role="dialog"`, `aria-modal`, ловушка фокуса и `Esc` — как в `SettingsDialog`; вкладки/переключатель «Весь экран»/«Окно»;
  сетка карточек с миниатюрой и именем (selected — рамка/галочка); повторная загрузка источников; сообщение, если Electron-API нет.
- Звук: радиогруппа «Без звука / Микрофон / Системный звук / Микрофон + системный звук»; селект устройства микрофона;
  недоступная опция disabled + причина. Если микрофона нет, по умолчанию «Системный звук» (если есть) иначе «Без звука».
- Качество: select с оценкой «≈N МБ/мин» и пояснением «WebM (VP9 + Opus) — встроенный плеер».
- Название: input (пусто → дефолт backend).
- Старт: busy-состояние, ошибки под кнопкой; после старта диалог закрывается, панель записи видна всегда.
- В основной панели видео при `status ∈ preparing | recording | paused | finalizing` вместо плеера
  показывается `RecordingPreview` (live-предпросмотр того, что пишется). Звук предпросмотра выключен,
  второй захват не создаётся; при старте записи встроенный плеер ставится на паузу; после сохранения
  панель возвращается к обычному плееру.
- `RecorderBar`: `position: fixed` внизу по центру; пульсирующая красная точка, «Запись»/«Пауза», `HH:MM:SS`,
  имя источника, размер, кнопки «Пауза/Продолжить», «Сохранить», «Отменить» (confirm). После сохранения:
  `refresh()` библиотеки, toast «Запись сохранена: <title>» с действием «Обработать» (`api.enqueue([videoId])`),
  открытие записи (`vl:open`).
- Ошибка отправки чанков/финализации видна в `RecorderBar` с кнопкой «Отменить».

## 7. Тесты и приёмка

### 7.1. Backend pytest (`backend/tests/test_m11_recordings.py`)

- фикстура: реальный WebM (VP9+Opus) через ffmpeg (`testsrc`+`sine`, 2 с), нарезка на чанки;
- start → chunks → finish: файл в `recordings/`, `videos` запись `pending` с title/duration/size, `playback_mode=direct`,
  `recordings` строка, thumb доступен, `video.status`/`recording.finished` опубликованы;
- mime/title валидация; неизвестная сессия 404; чанк после finish 409; слишком большой чанк 413 (подменить `MAX_CHUNK_BYTES`);
  пустая сессия → `recording_empty`; cancel удаляет временные файлы; повторный cancel — 204;
- fallback: битый/пустой ffmpeg (`config.ffmpeg='/bin/false'`) → файл всё равно регистрируется (copy fallback);
- capabilities: форма ответа; при отсутствии `pactl` `available=false` (monkeypatch `shutil.which`);
- system audio (skip, если PulseAudio/pactl недоступны): старт/пауза/продолжение/стоп; при финализации в итоговом WebM есть аудио-поток.

### 7.2. Frontend vitest

- `lib/recording.test.ts`: выбор mime (vp9→vp8→webm, audio/no-audio), пресеты, constraints, форматирование, оценка размера;
- `recordStore.test.ts` (fake `MediaRecorder`, `navigator.mediaDevices`, `vl()`, `api`): успешный цикл start→chunk→stop (finish вызван,
  `lastVideoId`, cleanup), pause/resume, cancel, ошибка getUserMedia → cleanup/error, ошибка загрузки чанка → cancel;
- `RecordDialog.test.tsx`: рендер источников/групп, disabled системного звука при недоступности, старт блокируется без источника,
  закрытие по Esc/Cancel;
- `RecorderBar.test.tsx` (если успеваем): таймер/пауза/confirm отмены.

### 7.3. E2E (Playwright, browser + mocked capture)

`e2e/recording.spec.ts`: в `page.addInitScript` подменяются `window.vl.getCaptureSources` (2 источника) и
`navigator.mediaDevices.getUserMedia`, `MediaRecorder` (эмитит реальный WebM-фикстур из `.tmp/e2e-videos/recording-fixture.webm`,
генерируется в `scripts/e2e-server.sh`). Сценарий: тулбар → «Запись экрана» → диалог → выбрать источник → начать →
панель записи → «Сохранить» → toast → в библиотеке новая запись (проверка через API: `total+1`, `playback_mode=direct`, duration>0).
Дополнительно: «Отменить» → библиотека не меняется, временные файлы удалены.

### 7.4. Команды приёмки

```bash
bash scripts/test.sh              # ruff + pytest + tsc + vitest
npx playwright test              # e2e (нужен chromium; в sandbox — PLAYWRIGHT_BROWSERS_PATH=$PWD/.tmp/ms-playwright)
bash scripts/build.sh?           # нет: npm run build (frontend+electron)
bash scripts/run-stack.sh        # ручная проверка API-записи
```

## 8. Разделение работ (write scopes)

| Владелец | Задача | Scope |
|---|---|---|
| backend-dev | API/сервисы/миграция/тесты | `backend/app/**`, `backend/tests/**` |
| electron-dev | IPC/разрешения + фронтовый движок записи и API-клиент | `electron/**`, `frontend/src/api/**`, `frontend/src/lib/recording.ts`, `frontend/src/state/recordStore.ts`, их тесты |
| ui-dev | диалог, панель, тулбар, App, i18n, CSS, UI-тесты | `frontend/src/components/recording/**`, `Toolbar.tsx`, `App.tsx`, `lib/i18n/ru.json`, `RecorderBar.test`/`RecordDialog.test` |
| qa-docs | e2e, docs, README, скрипт фикстур, финальный прогон | `e2e/**`, `scripts/e2e-server.sh`, `docs/**`, `README.md` |
| Lead | план, конвенции, интеграция, финальная проверка | `plans/**`, `PLAN.md` |

## 9. Открытые вопросы (не блокируют)

1. Нужна ли авто-транскрипция записей? Решение: **нет** (неожиданная нагрузка CPU); после сохранения toast с действием «Обработать».
2. Запись системного звука на Windows/macOS — вне объёма (целевая ОС — Ubuntu/Linux). При появлении требования — Electron loopback `setDisplayMediaRequestHandler`.
3. Ограничение длительности записи не вводится; размер ограничен свободным местом (ошибка чанка/финализации обрабатывается).
