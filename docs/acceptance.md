# Приёмка VideoLessons

Обновлено: 2026-10-27. Окружение прогона: dev-машина (Gentoo, Python 3.11.16, Node 26.10, ffmpeg 8.1, Docker 29.8).

## Итог локальных проверок

| Проверка | Команда | Результат |
|---|---|---|
| Backend lint | `.venv/bin/ruff check backend/app backend/tests` | ✅ All checks passed |
| Backend tests | `(cd backend && ../.venv/bin/python -m pytest -q -o addopts="")` | ✅ **279 passed, 4 skipped** (skip — real-model тесты M14 без `VL_SUMMARY_REAL=1`); включая M13 (model store), M14 rev2 (иерархическое дерево) и **V5 transfer (8 тестов)** |
| Frontend typecheck | `npm --prefix frontend run typecheck` | ✅ 0 ошибок |
| Frontend unit/component | `npm --prefix frontend run test` | ✅ **269 passed** (25 файлов; M13 modelsStore/ModelsSection 35, M14 rev2 DetailScale/summaryStore/TimingPanel 66, **V5 FileList/FolderPicker/fileBrowserStore/ContextMenu 38**) |
| Production build | `npm --prefix frontend run build` (выполняется playwright webServer) | ✅ `dist/` **331 KB JS** (gzip 97 KB) + **59 KB CSS** (gzip 10 KB) |
| Electron main build | `npm run build:electron` | ✅ `dist-electron/main.js`, `preload.js` |
| E2E (Playwright, Chromium) | `PLAYWRIGHT_BROWSERS_PATH=$PWD/.tmp/ms-playwright npx playwright test` | ✅ **19 passed**: 7 прежних + **2 M11** + **2 M12** + **2 M14** + **6 V5** (блочный вид/колонки, подменю у края окна, move через диалог, «↑», история, copy) |
| **M11: backend запись/финализация** | `pytest tests/test_m11_recordings.py` | ✅ **26 passed**, 0 skipped (подробно — в разделе M11 ниже) |
| **M11: e2e запись (mocked capture)** | `npx playwright test e2e/recording.spec.ts` | ✅ **2 passed** (сохранение → direct playback; отмена → библиотека не меняется) |
| **M11: Electron main/preload** | `npm run build:electron` | ✅ `dist-electron/main.js` 17.2 KB, `preload.js` 2.2 KB |
| **M12: backend семантика** | `pytest tests/test_m12_semantic_search.py` | ✅ **20 passed**, 0 skipped (реальная модель идёт: модель в `resources/models`; подробно — в разделе M12 ниже) |
| **M12: frontend семантика** | `npm --prefix frontend run test -- src/state/searchStore.test.ts src/components/SearchResults.test.tsx` | ✅ **34 passed** (+18 новых тестов M12) |
| **M12: e2e семантика + раскладка** | `npx playwright test e2e/semantic-search.spec.ts` | ✅ **2 passed** (режимы/чип/seek/переиндексация; панель под вкладками без обрезания) |
| Реальная транскрипция | faster-whisper 1.2.1, модель `tiny` INT8, русская речь (espeak-ng) | ✅ lang=ru, сегменты записаны в БД, отображены в UI |
| **HEVC 10-bit MKV (реальный файл пользователя)** | `playback` → `prepare-preview` → `preview` | ✅ план `transcode` (hevc/yuv420p10le + aac 6ch в mkv) → превью **h264, yuv420p, 1440×720**; Range 206; прогресс 0→100% |
| Изменение высоты панели предпросмотра | e2e (клавиатура) + `uiStore` unit | ✅ высота меняется и сохраняется в `localStorage` (`vl.ui.previewHeight`) |
| **Внешний плеер mpv: синхронизация** | `test_m9_external.py` (реальный mpv, headless `--vo=null`) | ✅ запуск с `--start`, duration/position из IPC, pause, seek, остановка |
| Метки как главы/субтитры | unit `test_marks_files_generation` | ✅ корректные `CHAPTERxx` и `.ass` с цветом/тегами |
| Sidecar PyInstaller (host) | `packaging/backend.spec` | ✅ onedir 425 MB, стартует, применяет миграции, печатает `VL_READY` |
| Sidecar PyInstaller (Ubuntu 22.04 Docker) | `scripts/build-backend.sh docker` | ✅ `backend-dist/vl-backend` 382 MB (собран на glibc 22.04) |
| Electron sidecar handshake | `electron .` (без GUI) | ✅ main запустил backend, получил `VL_READY`; GUI-окно в sandbox агента не отображается (нет доступа к X-авторизации) |
| Packaged backend (Docker-сборка) | `backend-dist/vl-backend` + curl | ✅ `/api/health`, `/api/models` (tiny bundled), SPA `index.html` отдаётся |
| `.deb` (ручная сборка ar+tar) | `scripts/build-deb.sh` | ✅ `dist/VideoLessons-0.1.0-amd64.deb` (352 MB): `control`, `postinst` (SUID chrome-sandbox), launcher `videolessons`, ресурсы backend/frontend/ffmpeg/models; установка на Ubuntu не выполнялась (нет dpkg в среде) |
| `.deb` (electron-builder) | `npm run dist` (`packaging/electron-builder.yml`) | ✅ `dist/VideoLessons-0.1.0-amd64.deb` (823 MB): `/opt/VideoLessons/resources/backend/vl-backend` + `_internal`, `frontend/dist`, `ffmpeg`, `models`; дефолтный `postinst` electron-builder: `/usr/bin/videolessons` (update-alternatives), `chrome-sandbox` SUID/0755 по наличию userns, AppArmor-профиль (Ubuntu 24+); установка на Ubuntu не выполнялась (нет dpkg в среде) |
| **AppImage (electron-builder)** | `npm run dist:appimage` → `scripts/check-artifacts.sh` + `scripts/smoke-sidecar.sh` | ✅ `dist/VideoLessons-0.1.0.AppImage` (898 MB): `resources/` вне asar содержит backend/frontend/ffmpeg/models (проверено `--appimage-extract`); AppImage запущен `--appimage-extract-and-run --no-sandbox --ozone-platform=headless` — `Starting backend: .../resources/backend/vl-backend` → `Backend ready`, `startup.window_visible` 443 мс; sidecar из распакованного AppImage: `/api/health` ok, SPA 200; полный e2e внутри AppImage: scan → enqueue → транскрипция tiny/ru → `status=done`, 2 сегмента. Реальный FUSE/GUI-запуск — открыт (нет X в среде) |
| **Frozen `multiprocessing` (sidecar)** | AppImage + `POST /api/videos/enqueue` | ✅ до фикса: 104 `VL_READY`, лавина дочерних процессов, `status=error`, inotify limit; после `multiprocessing.freeze_support()` в `backend/pyinstaller_entry.py`: один sidecar-процесс, `status=done`, 2 сегмента |

| **M13: модели вне бандла** | `pytest tests/test_m13_*.py`; `npm --prefix frontend run test` | ✅ backend **56 passed** (без сети, локальный HTTP: download/resume/checksum/cancel/import/delete/offline), frontend **35 tests** (modelsStore/ModelsSection); в артефакте `resources/models` отсутствует, есть `resources/llama/llama-cli`; `GET /api/models` — 7 моделей, обе summary-модели независимо устанавливаются |
| **M14: backend саммари (rev2)** | `pytest tests/test_m14_*.py` | ✅ **114 passed, 4 skipped** (fake LLM: OUTLINE fits/chunked+merge, рекурсивный SPLIT-дерево, покрытие/листья/MAX_DEPTH, динамические уровни, manager/API/SSE); реальная LFM2.5-350M — дерево `outline→split` построено, `max_level=2`, уровни «Подробно/Обзор», таймкоды валидны |
| **M14: frontend динамическая шкала** | `npm --prefix frontend run test`; `npx playwright test e2e/summary.spec.ts` | ✅ frontend **238 passed** (DetailScale 16: maxLevel 1/3/5, clamp/labels; summaryStore 30; TimingPanel 19: динамические уровни, корневой блок); e2e — число детентов = `max_level+1`, уровень 0 ↔ max, блоки/seek |
| **M13/M14: артефакты** | `npm run dist` → `scripts/check-artifacts.sh` + `scripts/smoke-sidecar.sh` | ✅ `dist/VideoLessons-0.1.0.AppImage` **342 МБ** и `.deb` **266 МБ** (было 941/823 МБ с моделями): без `resources/models`, с `resources/llama` (45 МБ); гейты ≤450/≤400 МБ пройдены; sidecar из `resources` стартует, `/api/health` ok, SPA 200 |
| **M14 bugfix: саммари без готового дерева** | `npm --prefix frontend run test`; `npx playwright test e2e/summary.spec.ts` | ✅ провизорная позиция «Саммари» при `max_level=0` даёт открыть/запустить генерацию при `summary.auto=false`; DetailScale maxLevel=0 (2 детента, активна), setLevel(1) → POST; e2e: удаление дерева → шкала → блоки саммари появились |
| **M14 rev3: крупные блоки и описания** | `pytest tests/test_m14_*.py`; прогон на копии БД пользователя (видео 24, Qwen) | ✅ нет листьев-гигантов (max level1 **44.6 с / 15.3%** видео, 21 блок), покрытие и порядок без пересечений; root «О чём видео + Темы» (8 тем); дубли title/description у сиблингов — 0; backend M14 **114 passed**, полный **271 passed/4 skipped**; фикс: force-split, инварианты, промоушен тем, дедуп |
| **M14 rev2: иерархическое саммари внутри AppImage** | AppImage `--appimage-extract-and-run`, llama.cpp из `resources/llama`, модели в `VL_MODELS_DIR` | ✅ `/api/health` 200 → `POST /api/videos/1/summary {force:true}` → `outlining` → `splitting` → `ready`; `max_level=2`, level1 «Подробно» — 4 блока, level2 «Обзор» — 1 корневой блок, `root_summary` заполнен; реальная LFM2.5-350M на CPU (не fake) |

Скриншоты: [docs/screens/app.png](screens/app.png); M12 — [результаты поиска](screens/search-results.png)
и [старая раскладка «до»](screens/search-results-before.png).

Артефакты (M13/M14): `dist/VideoLessons-0.1.0.AppImage` (**342 МБ**) и `dist/VideoLessons-0.1.0-amd64.deb` (**266 МБ**) — electron-builder 26 с конфигом `packaging/electron-builder.yml`. Конфиг лежит вне корня проекта, поэтому передаётся явно (`--config`, внутри `npm run dist`); в `package.json` **не должно быть** ключа `build` — при его наличии electron-builder игнорирует файл конфигурации, `extraResources` не применяются, AppImage выходит без `resources/backend` и приложение не может запустить backend (именно этот дефект исправлен). Второй дефект: `extraResources.to` для sidecar должен быть `backend` (плоская раскладка `resources/backend/vl-backend`), а не `backend/vl-backend` — иначе `spawn` падает с `EACCES`. Третий дефект (frozen-сборка): `backend/pyinstaller_entry.py` не вызывал `multiprocessing.freeze_support()`, поэтому spawn-процесс транскрипции заново исполнял entrypoint и поднимал второй backend (рекурсивная лавина процессов, inotify limit, транскрипция не работала). Исправлено; в `electron/backend.ts` поздний `VL_READY` от дочерних процессов игнорируется. Защита от регресса: `scripts/after-pack.js` роняет сборку, если backend/ffmpeg/SPA/модели не попали в пакет; после сборки — `scripts/check-artifacts.sh` и `scripts/smoke-sidecar.sh` (реальный старт sidecar, `/api/health`, отдача SPA).

Известные ограничения/следующие шаги: (1) AppImage собран на legacy-рантайме appimage-12.0.1, требующем `libfuse2`; на чистой Ubuntu 22.04/24.04 без libfuse2 нужен `--appimage-extract-and-run` либо `toolsets.appimage` со static-рантаймом; (2) после падения backend перезапускается на новом порту, но renderer кэширует baseUrl — нужен reload/подписка на статус; (3) не задан `desktopName` (ассоциация WM_CLASS); (4) реальный FUSE/GUI-запуск и установка `.deb` на чистую Ubuntu — открыты.

## M13 — Модели вне бандла (вне TARGET.md, план `plans/13-model-store.md`)

Реализовано: реестр `backend/app/model_manifest.json` (7 моделей: whisper tiny/base/small/medium, e5,
`summary-lfm2.5-350m`, `summary-qwen2.5-0.5b`) с pinned-ревизиями, размерами, SHA-256 LFS-файлов,
лицензиями, `recommended/default`; хранение `$VL_DATA_DIR/models`, `.installed.json`; legacy
`resources/models` — `bundled` (read-only); загрузчик `httpx` с прогрессом/Range-докачкой/retry,
SHA-256, атомарной установкой, импортом каталога/zip/tar.gz (traversal-защита), проверкой свободного
места, зеркалом `models.endpoint`, офлайн-режимом `models.offline`/`VL_OFFLINE=1`, SSE
`model.progress`/`model.state`; API `/api/models…`; UI «Настройки → Модели»: KoarAI — значок
«Рекомендованная» (без предупреждений), Qwen — «Альтернатива», обе устанавливаются одновременно.

Проверки: `pytest tests/test_m13_*.py` — 56 passed без сети; **реальная загрузка с HF через ModelStore**: `whisper-tiny` (78 203 619 Б) — downloading→verifying→ready, SHA-256 LFS-файла сошёлся; полный backend suite — 219 passed,
3 skipped; frontend modelsStore/ModelsSection — 35 tests; `GET /api/models` в frozen sidecar — 7 моделей.

## M14 — Саммари и шкала детализации (план `plans/14-summary-lfm.md`)

Реализовано (rev2): llama.cpp runtime b11669 (`resources/llama`, MIT), GGUF-модели из M13;
`services/llm/llama_cli.py` (GBNF вместо нерабочего `--json-schema`, `-sys/-p/-st/-rea off`, `<think>`,
timeout/kill, fake `VL_SUMMARY_FAKE=1`); **иерархическая декомпозиция** `services/summary/tree.py`
(OUTLINE всего текста; при переполнении — contiguous-чанки + MERGE верхнеуровневого саммари;
рекурсивный SPLIT блоков по смыслу до отдельных строк; листья ≤2 строк, MAX_DEPTH=8, лимиты узлов;
внутри блока при переполнении — чанки+OUTLINE), запись `summary_nodes`; материализация **динамических**
уровней (level1 — листья, max_level — корневой обзор, labels «Подробно/Темы/Обзор»); миграция 012;
API `/api/videos/{id}/summary` с `max_level/levels/root_summary`; `SummaryManager` с compute-gate;
UI `DetailScale` — число детентов = `max_level+1`, метки из API; `TimingPanel` — блоки с заголовками,
корневой блок, level 0 без регрессий; настройки `summary.enabled/auto/thinking/model`.

Проверки: backend M14 — 62 passed + 3 skipped (fake), реальные LFM 350M/Qwen 0.5B — 3 passed (MAP+REDUCE,
уровни, кэш); frontend 223 tests; e2e summary — 1 passed; плюс `docs/summary-eval.md` с наблюдениями.

## V5 — Блочный вид панели файлов и операции с папками (план `plans/15-file-grid-and-folder-ops.md`)

Реализовано: переключатель «Списком/Блоками» и настраиваемое число блоков в ряд (2…12, по умолчанию 6)
с персистом в `localStorage`; блочная сетка с превью/статусом/тегами, те же mouse/keyboard/DnD-сценарии,
что и в таблице; контекстное меню «Переместить в папку»/«Скопировать в папку» (оба вида) с подменю из
5 последних адресатов (`files.recent_destinations`) и модальным выбором новой папки (навигация по
watched roots, «↑», старт от родителя выбранного файла). Backend `POST /api/videos/transfer`: move через
`shutil.move` + `UPDATE videos.path` (с id/тегами/сегментами/метками/thumb), copy через `shutil.copy2` +
`scanner.upsert_file` (копия — `duplicate`/`duplicate_of` по G8), per-item ошибки/частичный успех, writes
только внутри watched roots. Проверки: backend `tests/test_m15_file_ops.py` — 8 passed; frontend +30
vitest (FileList 15, FolderPickerDialog 7, fileBrowserStore 13, ContextMenu 3); e2e `e2e/file-grid.spec.ts` — 6 passed
(6 колонок по умолчанию и смена числа, подменю у правого/нижнего края окна, move через диалог, «↑»,
повторное перемещение из истории, copy).

## M11 — Запись экрана/окна (вне TARGET.md, план `plans/11-screen-recording.md`)

Требование: запись всего экрана или окна (аудио+видео), просмотр **без внешнего плеера**, небольшой размер.
Реализовано: Electron `desktopCapturer` → `MediaRecorder` (**WebM VP9 + Opus**) → чанки
`POST /api/recordings/{id}/chunks` → ffmpeg-финализация (`-c copy`, `amix` системного звука) →
`scanner.upsert_file` → `videos(status='pending')` → встроенный плеер (`playback_mode='direct'`).
UI: диалог источников/звука/качества, плавающая панель записи (пауза/сохранить/отменить), toast с действием «Обработать».

| Проверка M11 | Команда | Результат |
|---|---|---|
| Backend API + финализация | `pytest tests/test_m11_recordings.py` | ✅ **26 passed**, 0 skipped: start/chunks/finish → файл в `recordings/`, строка `videos` pending, duration/size, `playback_mode=direct`, thumb, SSE; валидация (`invalid_source`/`invalid_mime`/404/409/413/`recording_empty`); cancel + повторный cancel; ffmpeg-fallback (copy) при `/bin/false`; capabilities; **реальный системный звук PulseAudio — оба маршрута без skip**: pulse (system ffmpeg `-f pulse`) и parec (release fallback: `parec`+pulseaudio-utils); monitor-звук реально захвачен, в финальном WebM есть Opus-поток (`system_audio=1`) |
| Frontend engine + UI | `npm --prefix frontend run test -- src/lib/recording.test.ts src/state/recordStore.test.ts src/components/recording` | ✅ **57 passed**: mime/пресеты/constraints; start→chunk→finish, pause/resume, cancel, ошибки/cleanup; диалог, панель и live-предпросмотр (REC-бейдж/таймер/источник, `srcObject`, оверлеи) |
| E2E mocked capture | `PLAYWRIGHT_BROWSERS_PATH=$PWD/.tmp/ms-playwright npx playwright test e2e/recording.spec.ts` | ✅ **2 passed**: сохранение (WebM-фикстура VP9+Opus из `.tmp/e2e-videos/recording-fixture.webm` → реальные chunks/finish → playback `direct` → toast/библиотека/`<video …/stream>`; проверен **live-предпросмотр** в панели видео: `<video>` с `srcObject`, REC/«Пауза»-бейдж, таймер; после сохранения предпросмотр уступает плееру) и отмена (204; библиотека и `recordings/` не меняются, `tmp/recordings/` очищен, сессия 404) |
| Electron main/preload | `npm run build:electron` | ✅ `dist-electron/main.js` 17.2 KB, `preload.js` 2.2 KB (IPC `vl:capture:sources`, permissions `media`/`display-capture` только для 127.0.0.1/localhost) |

Ограничения проверки: в sandbox нет X-дисплея, поэтому **реальный GUI Electron с настоящим `desktopCapturer`
не прогонялся**. e2e подменяет только слой захвата (`getCaptureSources`/`getUserMedia`/`MediaRecorder`),
а backend-конвейер (чанки, ffmpeg-финализация, библиотека, режим `direct`) — настоящий.
Остаётся ручной smoke на машине с X11/Wayland: `bash scripts/dev.sh` → «Запись экрана» → экран/окно →
запись с микрофоном и системным звуком → пауза/сохранение → воспроизведение в приложении.

Примечание к релизу (системный звук): на Linux нужны **`pactl` и `parec` (пакет `pulseaudio-utils`)** либо
системный ffmpeg с libpulse. **Поставляемый статический ffmpeg не содержит pulse-демаксера**, поэтому в релизной
поставке используется маршрут `parec` (monitor sink → PCM → встроенный ffmpeg кодирует Ogg/Opus); на Windows/macOS
системный звук не поддерживается (только микрофон). В `.deb` добавлен `Recommends: pulseaudio-utils`
(`packaging/electron-builder.yml`, `scripts/build-deb.sh`), т.е. пакет ставится по умолчанию; без него приложение
работает, но системный звук недоступен (микрофон — доступен).

## M12 — Семантический поиск и панель результатов (вне TARGET.md, план `plans/12-semantic-search.md`)

Требование: поиск **по смыслу** с приоритетом русского языка (морфология/синонимы) — локально и офлайн;
дополнительно — исправить перекрытие панели результатов вкладками «Файлы/Метки».
Реализовано: `multilingual-e5-small` ONNX int8 (384d, mean-pool + L2, префиксы e5 `query:`/`passage:`) →
таблица `segment_embeddings` (миграция 009, BLOB float32, каскад); автоиндексация после транскрипции,
фоновая доиндексация при старте и кнопка/эндпоинт «Переиндексировать»; режимы `fts|semantic|hybrid`
(гибрид — RRF k=60); семантика по сегментам, файлы/метки — лексически; без модели — деградация в FTS.
UI: режимы **Обычный/Семантика/Гибрид**, статус «Проиндексировано X/Y», кнопка переиндексации, чип
«семантика»; панель результатов перенесена **под вкладки** и заменяет список.

| Проверка M12 | Команда | Результат |
|---|---|---|
| Backend: сервис/индекс/режимы/RRF | `pytest tests/test_m12_semantic_search.py` | ✅ **20 passed, 0 skipped**: индексация/upsert/force/каскад, кэш матрицы, косинус/top, RRF (порядок/дедуп/`semantic=true`), fallback `mode_used=fts`, `invalid_mode` 422, scope files/annotations, API status/reindex, SSE, queue-hook, миграция 9 |
| Backend: реальная модель (русский) | `pytest tests/test_m12_semantic_search.py::test_real_model_russian_semantic_search` | ✅ запрос «как найти производную сложной функции» → top-1 «Производная сложной функции…», **cos 0.8714** (2-е «Квадратное уравнение» 0.8089, 3-е Python 0.7683); dim 384 |
| Морфология: FTS vs семантика | наш замер на тех же 4 сегментах | ✅ «производные сложных функций»: **FTS total 0**, semantic top **cos 0.882**; «как найти производную…»: FTS 0 vs semantic 0.8714 |
| Гибрид RRF | наш замер `search_service.search(mode="hybrid")` | ✅ «производная сложной функции» (FTS=1): FTS-ранг 0 + semantic-ранг 0 → **RRF 0.032787 = 2/61** (k=60), `semantic=true`, `mode_used=hybrid`; при совпадении только в семантике — 1/61 |
| Латентность/размер | наш замер (dev CPU) | ✅ поиск **1,3–1,5 мс** (p10/p90; первый после загрузки ~1,8 мс); загрузка модели + первый encode ~0,53 с; индексация 4 сегментов с загрузкой ~0,6 с; **~1,5 КБ** вектора/сегмент; модель **130 МБ** (113 ONNX + 17 tokenizer) |
| Frontend: режимы/статус/чип/стор | `npm --prefix frontend run test -- src/state/searchStore.test.ts src/components/SearchResults.test.tsx` | ✅ **34 passed** (`searchStore` 21 = +13 M12, `SearchResults` 13 = +5 M12; итого +18) |
| E2E: семантика/гибрид/seek/reindex | `PLAYWRIGHT_BROWSERS_PATH=$PWD/.tmp/ms-playwright npx playwright test e2e/semantic-search.spec.ts` | ✅ **2 passed**: ожидание `available && indexed_segments>0` (≤180 с); API: FTS 0 vs semantic/hybrid находит lesson-03 (`semantic=true`, `mode_used`); UI: «Семантика»/«Гибрид», чип «семантика», клик → `vl:open`+`vl:seek` → плеер на таймкоде сегмента; `POST reindex {force:true}` → 202 `indexing` → `indexing=false` |
| E2E: регрессия раскладки | тот же спек, тест 2 | ✅ `.vl-search` начинается под `.vl-app__viewbar` (`search.top ≥ viewbar.bottom−1`), внутри `.vl-app__main`, `.vl-app__list` при поиске отсутствует, высота панели >120 px, последняя строка не обрезана, список `overflow-y:auto`; вкладка «Файлы» и «×» возвращают список и очищают ввод. Скриншоты: [до](screens/search-results-before.png) / [после](screens/search-results.png) |

Ограничения проверки: e2e использует tiny-модель транскрипции на синтезированной речи; на e2e-фикстуре её
текст получается искажённым («Сыванная мюро-берэм…», наблюдение прогона), поэтому e2e проверяет **проводку**
семантики (индекс, режимы, RRF, seek, геометрию панели), а качество ранжирования на русском — backend-тест
с реальной моделью и курированными сегментами (cos 0.87–0.88). Модель в dev/e2e — та же int8 ONNX, что
пойдёт в релиз.

## Критерии TARGET.md §7

M11 (запись экрана) и M12 (семантический поиск) — сверх `TARGET.md`; их критерии и доказательства — в разделах M11/M12 выше.

| # | Критерий | Статус | Чем проверено / что осталось |
|---|---|---|---|
| 1 | Первый запуск `.deb` на Ubuntu без Python/ffmpeg, окно < 5 с | ⚠️ артефакт готов | `.deb` собран и проверен по структуре; установка/запуск на чистой Ubuntu — `scripts/vm-smoke.sh` (нужна VM) |
| 2 | Индексация папки с 3 видео, корректные длительности | ✅ | `test_m2_library.py` (scan/ffprobe/дедуп/список), e2e «библиотека загружается» |
| 3 | Транскрипция RU 10 мин, задержка прогресса | ⚠️ частично | Пайплайн проверен на коротком клипе (tiny). Нужен прогон 10-мин файла моделью `small` на целевом CPU: время/RTF и задержка прогресса |
| 4 | Поиск слова → файл и таймкод, клик → seek | ✅ | `test_m4_search.py`, e2e «поиск по меткам» |
| 4a | **Поиск по меткам** (требование пользователя) | ✅ | `test_m7_annotations.py::test_search_annotations` (FTS label/note, tag:, цвет, scope), e2e создание+поиск+seek |
| 5 | Клик по сегменту → seek, подсветка, автопрокрутка | ✅ (UI), автопрокрутка — ручная проверка | e2e открытие видео; `TimingPanel.test.tsx` (scrollIntoView block:'nearest') |
| 6 | Иерархия тегов, фильтр | ✅ API / ⏳ e2e фильтра | `test_m6_tags.py` (дерево, глубина, циклы, фильтры, экспорт/импорт); UI TagTree/FileList-фильтр покрыты unit-тестами |
| 7 | Метка 00:30–01:15 видна и кликабельна | ✅ | e2e: метка 00:01–00:02 создана через диалог, маркер отрисован, панель показывает |
| 8 | Перезапуск восстанавливает состояние | ⚠️ частично | `localStorage` (тема/ширины/таб) + БД; нужен ручной/VM-прогон |
| 9 | Закрытие во время транскрипции ≤ 5 с, БД цела | ⏳ | Graceful shutdown sidecar реализован (`stop()` + SIGTERM); нужен прогон на VM |
| 10 | Нет исходящих запросов | ⏳ | Проверка `ss -tp`/`tcpdump` на чистой VM |

## Ограничения текущего прогона

- GUI Electron в sandbox агента недоступен (X-авторизация вне sandbox), поэтому UI проверен в headless Chromium против production-сборки, которую отдаёт backend; Electron main проверен по логу (sidecar handshake). **M11:** реальный `desktopCapturer` и настоящий `MediaRecorder` в Electron не проверены (нет X); e2e записи использует mocked-слой захвата + реальный backend-конвейер, реальный smoke остаётся ручным.
- **M11, системный звук:** в релизе требуется `parec` (`pulseaudio-utils`) — у поставляемого static ffmpeg нет pulse-демаксера; в backend-тестах оба реальных маршрута (pulse и parec) на этой машине пройдены (26/26, 0 skipped; `pactl`, `parec`, default sink есть). На Windows/macOS системный звук недоступен (только микрофон).
- В `resources/models` лежит `tiny` (75 MB) для dev/e2e; релизный пакет должен содержать `small` INT8 (`scripts/fetch-model.sh small`, ~484 MB) — в артефакт не включён из-за размера.
- `resources/ffmpeg` заполняется `scripts/fetch-ffmpeg.sh` (статический бинарник); для LGPL-сборки задать `FFMPEG_URL`.
- Реальная транскрипция проверена на синтезированной речи (espeak-ng) — качество текста ограничено моделью `tiny`; для `small` точность выше. **M12-наблюдение:** на e2e-фикстуре tiny-транскрипция получается искажённой, поэтому качество семантического ранжирования проверяется backend-тестом с реальной моделью и курированными русскими сегментами, а e2e — проводку/режимы/геометрию.
- **M12, модель:** `resources/models/multilingual-e5-small-onnx` (~130 МБ) в git не входит и скачивается `scripts/fetch-embed-model.sh`; без модели приложение работает только с обычным поиском (режимы семантики disabled с причиной). Модель — MIT (`intfloat/multilingual-e5-small`, ONNX-экспорт Xenova). В релизный `.deb` добавляется +~130 МБ.

## Сквозные сценарии (ручные, чистая VM)

1. Урок 10 мин (модель `small`) → метка 00:30–01:15 «важный пример» + тег → видна на таймлайне и в панели.
2. Поиск по слову из названия метки → строка «метка» → клик → плеер на 00:30, маркер подсвечен.
3. `tag:важное` → метки с тегом и дочерними.
4. Перетаскивание границы метки → сохранено, переход на новый `start`.
5. Удаление метки → `Ctrl+Z` возвращает её с тегами.
6. Перезапуск → метки, теги, ширины панелей восстановлены.
7. **M11:** «Запись экрана» → весь экран/окно → запись 10–20 с с микрофоном и системным звуком → пауза/продолжение → сохранить → запись появляется в библиотеке и играется встроенным плеером; «Отменить» → библиотека не меняется, `tmp/recordings/` пуст.
8. **M12:** после транскрипции видео со словом «производная» запрос «как найти производную сложной функции» в режиме «Гибрид» (область «Сегменты») → результат с чипом «семантика», клик → плеер на таймкоде сегмента; «Обычный» на этом запросе даёт 0 результатов; «Переиндексировать» → статус «Индексируется X/Y» → снова «Проиндексировано»; панель результатов под вкладками, список прокручивается, «Файлы»/«×» закрывают поиск.
