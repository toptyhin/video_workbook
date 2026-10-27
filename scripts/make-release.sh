#!/usr/bin/env bash
# Полный релиз: backend (Docker) + frontend + electron-builder (.deb/.AppImage).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
scripts/fetch-ffmpeg.sh
scripts/fetch-llama-runtime.sh   # M14: pinned CPU llama.cpp для саммари
# M13: модели больше не входят в бандл — их скачивает пользователь из настроек.
scripts/build-backend.sh docker
scripts/build-electron.sh
mkdir -p dist
# --config обязателен: конфиг лежит в packaging/, а electron-builder ищет
# electron-builder.yml только в корне проекта. npm-скрипт dist прокидывает его.
npm run dist
scripts/check-artifacts.sh
scripts/smoke-sidecar.sh
ls -la dist/
