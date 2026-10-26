# Приёмка VideoLessons

Обновлено: 2026-10-26. Окружение прогона: dev-машина (Gentoo, Python 3.11.16, Node 26.10, ffmpeg 8.1, Docker 29.8).

## Итог локальных проверок

| Проверка | Команда | Результат |
|---|---|---|
| Backend lint | `.venv/bin/ruff check backend/app backend/tests` | ✅ All checks passed |
| Backend tests | `(cd backend && ../.venv/bin/python -m pytest)` | ✅ **55 passed** (M1–M7 + preview + external: skeleton, library, queue, search, tags, annotations, preview, mpv IPC, auth/SSE) |
| Frontend typecheck | `npm --prefix frontend run typecheck` | ✅ 0 ошибок |
| Frontend unit/component | `npm --prefix frontend run test` | ✅ **66 passed** (13 файлов) |
| Production build | `npm --prefix frontend run build` | ✅ `dist/` 273 KB JS + 37 KB CSS |
| Electron main build | `npm run build:electron` | ✅ `dist-electron/main.js`, `preload.js` |
| E2E (Playwright, Chromium) | `npx playwright test` | ✅ **7 passed**: библиотека, открытие видео + транскрипция, **CTA внешнего плеера для HEVC/MKV + диалог запуска**, изменение высоты панели, создание метки, поиск по меткам, панель «Метки» |
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

Скриншот: [docs/screens/app.png](screens/app.png)

Артефакт: `dist/VideoLessons-0.1.0-amd64.deb` (352 MB). AppImage не собран: в среде нет `mksquashfs`/appimagetool, electron-builder падает на tmp-сокетах sandbox — ручной `.deb` собран через `ar`+`tar` (`scripts/build-deb.sh`). — список «Метки», плеер, таймпанель с сегментом и меткой, таймлайн с маркером.

## Критерии TARGET.md §7

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

- GUI Electron в sandbox агента недоступен (X-авторизация вне sandbox), поэтому UI проверен в headless Chromium против production-сборки, которую отдаёт backend; Electron main проверен по логу (sidecar handshake).
- В `resources/models` лежит `tiny` (75 MB) для dev/e2e; релизный пакет должен содержать `small` INT8 (`scripts/fetch-model.sh small`, ~484 MB) — в артефакт не включён из-за размера.
- `resources/ffmpeg` заполняется `scripts/fetch-ffmpeg.sh` (статический бинарник); для LGPL-сборки задать `FFMPEG_URL`.
- Реальная транскрипция проверена на синтезированной речи (espeak-ng) — качество текста ограничено моделью `tiny`; для `small` точность выше.

## Сквозные сценарии (ручные, чистая VM)

1. Урок 10 мин (модель `small`) → метка 00:30–01:15 «важный пример» + тег → видна на таймлайне и в панели.
2. Поиск по слову из названия метки → строка «метка» → клик → плеер на 00:30, маркер подсвечен.
3. `tag:важное` → метки с тегом и дочерними.
4. Перетаскивание границы метки → сохранено, переход на новый `start`.
5. Удаление метки → `Ctrl+Z` возвращает её с тегами.
6. Перезапуск → метки, теги, ширины панелей восстановлены.
