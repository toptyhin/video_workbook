# VideoLessons

Локальное десктопное приложение для видеоуроков: индексация папок, локальная CPU-транскрипция
(faster-whisper), полнотекстовый поиск, синхронизированный плеер с панелью таймингов,
иерархические теги и пользовательские метки на фрагменты видео с поиском по ним.

Планы реализации — `PLAN.md` и `plans/`.

## Структура

- `backend/` — FastAPI + SQLite (sidecar-процесс)
- `frontend/` — Vite + React + TypeScript (SPA, отдаётся бэкендом)
- `electron/` — main/preload, запуск sidecar
- `scripts/` — dev/test/ci/сборка
- `docs/` — архитектура, руководство, приёмка

## Быстрый старт (dev)

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
npm install
npm --prefix frontend install
scripts/dev.sh
```
