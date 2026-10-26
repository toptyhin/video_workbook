# VideoLessons

Локальное десктопное приложение для видеоуроков: индексация папок, **локальная CPU-транскрипция**
(faster-whisper), полнотекстовый поиск, синхронизированный плеер с панелью таймингов,
иерархические теги и **пользовательские метки на фрагменты видео с поиском по ним**.

План и контракты: [PLAN.md](PLAN.md), [plans/](plans/). Спека: [TARGET.md](TARGET.md).
Скриншот: [docs/screens/app.png](docs/screens/app.png).

## Стек

| Слой | Технологии |
|---|---|
| Оболочка | Electron 31, esbuild, electron-builder |
| Backend | Python 3.11, FastAPI, uvicorn, faster-whisper (CPU INT8), ffmpeg |
| БД | SQLite (WAL) + FTS5 |
| Frontend | Vite 6, React 18, TypeScript, zustand |
| Тесты | pytest (45), vitest/RTL (54), Playwright (5 e2e) |

## Быстрый старт (dev)

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/pip install -r backend/requirements-ml.txt   # faster-whisper (может не понадобиться для UI)
npm install
npm --prefix frontend install

# опционально: модель для реальной транскрипции (tiny — 75 МБ, small — ~484 МБ)
bash scripts/fetch-model.sh tiny

# полный dev-режим: backend :8765 + Vite :5173 + Electron
bash scripts/dev.sh
```

Если GUI недоступен (headless/CI), используйте production-стек в браузере:

```bash
npm --prefix frontend run build
bash scripts/run-stack.sh      # печатает VL_READY-порт, SPA отдаётся бэкендом
```

## Проверки

```bash
bash scripts/test.sh                 # ruff + pytest + tsc + vitest
npx playwright test                  # e2e (собирает frontend и поднимает временный backend)
bash scripts/acceptance.sh           # приёмка API (12 проверок) → dist/acceptance/report.json
```

## Сборка

```bash
# backend: PyInstaller onedir в Docker Ubuntu 22.04 (релиз)
bash scripts/build-backend.sh docker   # → backend-dist/vl-backend

# ресурсы: статический ffmpeg + модель
bash scripts/fetch-ffmpeg.sh
bash scripts/fetch-model.sh small

# electron: frontend + main + .deb/.AppImage
bash scripts/make-release.sh
```

## Данные

`~/.local/share/VideoLessons/`: `library.db`, `logs/backend.log`, `cache/thumbs/`, `tmp/`.
Можно переопределить `VL_DATA_DIR`. Другие переменные: `VL_TOKEN`, `VL_RESOURCES_DIR`, `VL_FRONTEND_DIR`, `VL_PORT`.

## Документация

- [docs/architecture.md](docs/architecture.md) — процессы, БД, API, сборка
- [docs/user-guide.md](docs/user-guide.md) — папки, поиск, теги, метки, клавиши
- [docs/acceptance.md](docs/acceptance.md) — статус приёмки по TARGET.md §7
- [plans/00-conventions.md](plans/00-conventions.md) — контракты и API

## Статус

M1–M7 реализованы и покрыты тестами; M8 — backend собирается PyInstaller/Docker, .deb/AppImage — через `make-release.sh`;
M9 — темы/настройки/клавиши/уведомления в UI. Открытые пункты приёмки (чистая VM, 10-мин прогон `small`, offline-проверка) — в `docs/acceptance.md`.
