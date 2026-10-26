#!/usr/bin/env bash
# Сборка sidecar: Docker ubuntu:22.04 (релиз) или локально (dev-проверка spec).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
MODE="${1:-local}"

if [ "$MODE" = "docker" ]; then
  IMAGE="${VL_BUILD_IMAGE:-videolessons-build:22.04}"
  docker build -t "$IMAGE" -f packaging/docker/Dockerfile.build .
  docker run --rm -v "$ROOT:/build" -v "$ROOT/.cache/pip:/root/.cache/pip" "$IMAGE"
else
  if [ ! -x "$ROOT/.venv/bin/pyinstaller" ]; then
    "$ROOT/.venv/bin/pip" install -q pyinstaller
  fi
  ( cd backend && "$ROOT/.venv/bin/pyinstaller" --clean --noconfirm ../packaging/backend.spec )
  mkdir -p backend-dist
  rm -rf backend-dist/vl-backend
  cp -r backend/dist/vl-backend backend-dist/
  echo "backend-dist собран (локально, glibc хоста)"
fi
