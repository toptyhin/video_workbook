#!/usr/bin/env bash
# Полный релиз: backend (Docker) + frontend + electron-builder (.deb/.AppImage).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
scripts/fetch-ffmpeg.sh
scripts/fetch-model.sh "${VL_MODEL:-small}"
scripts/build-backend.sh docker
scripts/build-electron.sh
mkdir -p dist
npx electron-builder --linux deb AppImage --publish never
ls -la dist/
