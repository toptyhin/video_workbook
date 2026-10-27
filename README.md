# VideoLessons

Локальное десктопное приложение для видеоуроков: индексация папок, **локальная CPU-транскрипция**
(faster-whisper), полнотекстовый поиск, синхронизированный плеер с панелью таймингов,
иерархические теги и **пользовательские метки на фрагменты видео с поиском по ним**.
**Запись экрана/окна (аудио+видео)**: Electron `desktopCapturer` → `MediaRecorder` (**WebM VP9 + Opus**,
≈11–45 МБ/мин в зависимости от пресета) → чанки в backend → финализация ffmpeg → библиотека;
запись играется **встроенным плеером, без внешнего плеера**. Во время записи в основной панели видео
показывается **live-предпросмотр** захватываемого экрана/окна. Системный звук (Linux PulseAudio/PipeWire)
подмешивается к микрофону при сохранении.
HEVC/10-bit MKV открываются во внешнем mpv с синхронизацией позиции/меток (VLC/системный — без sync)
или конвертируются в приложении (прогресс + кэш); высота панели предпросмотра изменяется перетаскиванием.
**Семантический поиск (M12)**: поиск по смыслу и русской морфологии с моделью
`multilingual-e5-small` (ONNX int8, офлайн) в режимах **Обычный / Семантика / Гибрид** (RRF); панель
результатов теперь под вкладками «Файлы/Метки», прокручивается и не перекрывается ими.
**Панель файлов (V5)**: список отображается **строчно или блоками** — количество блоков в ряд
настраивается (по умолчанию 6) и запоминается; в обоих режимах контекстное меню умеет
**«Переместить в папку»** и **«Скопировать в папку»** с историей последних 5 папок-назначений и выбором
нового размещения.

План и контракты: [PLAN.md](PLAN.md), [plans/](plans/). Спека: [TARGET.md](TARGET.md).
Скриншоты: [app.png](docs/screens/app.png), [диалог записи](docs/screens/recording-dialog.png),
[панель записи](docs/screens/recording-bar.png), [семантический поиск](docs/screens/search-results.png).

## Стек

| Слой | Технологии |
|---|---|
| Оболочка | Electron 31, esbuild, electron-builder |
| Backend | Python 3.11, FastAPI, uvicorn, faster-whisper (CPU INT8), ffmpeg |
| БД | SQLite (WAL) + FTS5 |
| Frontend | Vite 6, React 18, TypeScript, zustand |
| Запись экрана | Electron desktopCapturer/MediaRecorder, WebM VP9+Opus, ffmpeg-финализация, PulseAudio (системный звук) |
| Семантический поиск | `multilingual-e5-small` ONNX int8 (384d, mean-pool + L2), numpy brute-force косинус, RRF k=60 |
| Тесты | pytest (**279 passed, 4 skipped**), vitest/RTL (**269**, 25 файлов), Playwright (**19 e2e**) |

## Быстрый старт (dev)

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/pip install -r backend/requirements-ml.txt   # faster-whisper (может не понадобиться для UI)
npm install
npm --prefix frontend install

# опционально: модель для реальной транскрипции (tiny — 75 МБ, small — ~484 МБ)
bash scripts/fetch-model.sh tiny

# опционально: модель эмбеддингов для семантического поиска (~130 МБ);
# без неё приложение работает, но только с обычным (лексическим) поиском
bash scripts/fetch-embed-model.sh

# полный dev-режим: backend :8765 + Vite :5173 + Electron
bash scripts/dev.sh

# только backend + Vite (без Electron; UI в браузере http://127.0.0.1:5173/)
VL_NO_ELECTRON=1 bash scripts/dev.sh
```

`dev.sh` ждёт готовности backend и Vite (до 60/90 с) и только потом запускает Electron;
если Vite не поднялся — печатает его лог. Vite слушает `127.0.0.1:5173` (IPv4, не только localhost).

Если GUI недоступен (headless/CI), используйте production-стек в браузере:

```bash
npm --prefix frontend run build
bash scripts/run-stack.sh      # печатает VL_READY-порт, SPA отдаётся бэкендом
```

## Проверки

```bash
bash scripts/test.sh                 # ruff + pytest + tsc + vitest
npx playwright test                  # e2e (18; собирает frontend и поднимает временный backend)
# sandbox без браузеров в кэше: PLAYWRIGHT_BROWSERS_PATH=$PWD/.tmp/ms-playwright npx playwright test
bash scripts/acceptance.sh           # приёмка API (12 проверок) → dist/acceptance/report.json
```

Реальная модель llama.cpp проверяется только с `VL_SUMMARY_REAL=1`; без неё 4 теста
`tests/test_m14_real_model.py` пропускаются (pytest: **279 passed, 4 skipped**, vitest: **269**, 25 файлов,
Playwright: **19 e2e**).

## Сборка

```bash
# backend: PyInstaller onedir в Docker Ubuntu 22.04 (релиз)
bash scripts/build-backend.sh docker   # → backend-dist/vl-backend

# runtime-ресурсы: статический ffmpeg + pinned CPU llama.cpp (модели НЕ входят в пакет, M13)
bash scripts/fetch-ffmpeg.sh
bash scripts/fetch-llama-runtime.sh   # M14: llama-cli + libs в resources/llama (~45 МБ, MIT)

# dev/e2e-модели (в релизный артефакт не попадают; пользователь скачивает их из настроек)
bash scripts/fetch-model.sh small
bash scripts/fetch-embed-model.sh

# electron: frontend + main + артефакты electron-builder (.deb + AppImage)
bash scripts/build-electron.sh
npm run dist                       # .deb + AppImage → dist/ (конфиг packaging/electron-builder.yml)
npm run dist:appimage              # только AppImage
npm run dist:dir                   # только распакованное приложение (быстрая проверка раскладки)

# ручная альтернатива без electron-builder
bash scripts/build-deb.sh          # .deb через ar+tar → dist/VideoLessons-*.deb

# полный релиз: ресурсы + backend в Docker + frontend + артефакты + проверки
bash scripts/make-release.sh
```

**Важно для AppImage/`.deb`:** конфиг electron-builder лежит в `packaging/electron-builder.yml`,
поэтому его нужно передавать явно — `npm run dist`/`make-release.sh` уже делают это. Не добавляйте
ключ `"build"` в `package.json`: при его наличии electron-builder **игнорирует** файл конфигурации,
`extraResources` не применяются, и AppImage выходит без backend/SPA/ffmpeg/llama (в `app.asar`
при этом затягивается весь репозиторий). Модели в `extraResources` **не входят** (M13): их скачивает
пользователь в «Настройки → Модели» в `$VL_DATA_DIR/models` (или импортирует офлайн). Проверки после
сборки: `scripts/check-artifacts.sh` (раскладка, наличие llama-runtime, отсутствие моделей, размеры)
и `scripts/smoke-sidecar.sh` (реальный запуск sidecar из `resources/`, `/api/health`, отдача SPA).

## Данные

`~/.local/share/VideoLessons/`: `library.db`, `logs/backend.log`, `cache/thumbs/`, `tmp/`,
`recordings/` (записи экрана/окна, WebM). Эмбеддинги M12 — в `library.db` (`segment_embeddings`,
~1,5 КБ/сегмент). Модели (M13) — в `~/.local/share/VideoLessons/models/` (`VL_MODELS_DIR`): whisper,
e5 и две модели саммари (LFM2.5-350M-Thinking — рекомендованная, Qwen2.5-0.5B — альтернатива); обе
summary-модели можно держать установленными одновременно; старые `resources/models` читаются как «Встроена».
Саммари/кэш — в `library.db` (`summary_chunks`, `summary_levels`). Можно переопределить `VL_DATA_DIR`. Другие переменные: `VL_TOKEN`, `VL_RESOURCES_DIR`, `VL_FRONTEND_DIR`, `VL_PORT`,
`VL_EMBEDDING_MODEL_DIR`, `VL_EMBED_AUTOINDEX`, `VL_EMBED_THREADS`.

## Документация

- [docs/architecture.md](docs/architecture.md) — процессы, БД, API, сборка
- [docs/user-guide.md](docs/user-guide.md) — папки, список/блоки и перемещение в папку, запись экрана, поиск, теги, метки, клавиши
- [docs/acceptance.md](docs/acceptance.md) — статус приёмки по TARGET.md §7
- [plans/00-conventions.md](plans/00-conventions.md) — контракты и API

## Статус

M1–M7 реализованы и покрыты тестами; добавлены автопревью HEVC/MKV (transcode/remux с кэшем) и изменяемая высота панели предпросмотра; M8 — backend собирается PyInstaller/Docker, electron-builder собирает `.deb` и `.AppImage` с проверками раскладки и запуска sidecar (`scripts/check-artifacts.sh`, `scripts/smoke-sidecar.sh`); ручной `.deb` — `scripts/build-deb.sh`;
M9 — темы/настройки/клавиши/уведомления в UI; **M11 — запись экрана/окна**: WebM VP9+Opus в библиотеке,
встроенный плеер без внешних программ, микрофон/системный звук Linux, пауза и отмена записи.
Проверки M11: backend pytest 26/26 (включая реальный PulseAudio-захват — оба маршрута, pulse и parec), frontend vitest 57 (engine + UI + live-предпросмотр),
e2e 2 (mocked capture + реальный backend-конвейер); на момент M11 полный прогон — 80+1 pytest, 123 vitest, 9 e2e.
Реальный GUI Electron с `desktopCapturer` в sandbox без X не проверялся — остаётся ручной smoke (см. `docs/acceptance.md`).
**M12 — семантический поиск**: `multilingual-e5-small` ONNX int8, индексация сегментов транскрибации после
транскрипции/фоном, режимы Обычный/Семантика/Гибрид (RRF k=60), онлайн-статус и переиндексация; панель
результатов перенесена под вкладки и больше не перекрывается. Проверки: backend M12 20/20 (реальная модель:
запрос «как найти производную сложной функции» → top cos 0.8714), frontend +18 тестов (141 всего),
e2e +2 (семантика/гибрид/seek/переиндексация и геометрия панели), полный прогон — 100+1 pytest, 141 vitest, 11 e2e.
**M13 — модели вне бандла**: реестр с pinned-ревизиями/SHA-256/лицензиями, скачивание/докачка/отмена/
зеркало/импорт/офлайн из «Настройки → Модели»; обе summary-модели устанавливаются одновременно; артефакты
без `resources/models`: текущая сборка — **342 МБ AppImage / 266 МБ `.deb`** (раньше 941/823 МБ) с llama-runtime 45 МБ.
**M14 — саммари**: локальный llama.cpp/GGUF (KoarAI LFM2.5-350M-Thinking — рекомендованная, Qwen2.5-0.5B —
альтернатива), уровни детализации 0–4 и вертикальная шкала в панели таймингов; проверки — `docs/summary-eval.md`.
**V5 — панель файлов и папки**: блочный вид с настраиваемым числом блоков в ряд (default 6, viewMode и
число колонок в `localStorage`); контекстное меню «Переместить в папку»/«Скопировать в папку» с историей
5 адресатов (`files.recent_destinations`) и диалогом выбора новой папки; backend `POST /api/videos/transfer`
(within watched roots, частичный успех, копии — `duplicate`). Проверки: backend +8 pytest, frontend +30 vitest,
e2e +6 (блочный вид/колонки, подменю у края окна, move через диалог, «↑», история, copy).
Открытые пункты приёмки (чистая VM, 10-мин прогон `small`, offline-проверка) — в `docs/acceptance.md`.
Модель эмбеддингов распространяется по лицензии MIT (`intfloat/multilingual-e5-small`, ONNX-экспорт
`Xenova/multilingual-e5-small`); офлайн-рантайм, модель скачивается только скриптом. Лицензии — в
`resources/THIRD-PARTY-NOTICES.md`.

### Примечание к релизу: системный звук записи

Захват системного звука (Linux) требует **`pactl` и `parec` (пакет `pulseaudio-utils`)** либо системного
ffmpeg с libpulse. **Поставляемый статический ffmpeg не содержит pulse-демаксера**, поэтому в релизной
поставке `parec` пишет monitor-звук в PCM, а встроенный ffmpeg кодирует его в Ogg/Opus и подмешивает при
финализации записи. На Windows/macOS системный звук недоступен — доступен только микрофон.
