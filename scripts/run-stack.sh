#!/usr/bin/env bash
# Запускает backend с собранным SPA на динамическом порту; печатает URL и ждёт.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export VL_TOKEN="${VL_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
export VL_DATA_DIR="${VL_DATA_DIR:-$ROOT/.tmp/stack-data}"
export VL_FRONTEND_DIR="${VL_FRONTEND_DIR:-$ROOT/frontend/dist}"
export VL_RESOURCES_DIR="${VL_RESOURCES_DIR:-$ROOT/resources}"
mkdir -p "$VL_DATA_DIR"
if [ ! -f "$VL_FRONTEND_DIR/index.html" ]; then
  echo "Нет сборки frontend ($VL_FRONTEND_DIR). Выполните: npm --prefix frontend run build" >&2
  exit 1
fi
cd backend
VL_PORT=0 "$ROOT/.venv/bin/python" -m app.main 2>&1 | tee "$ROOT/.tmp/stack.log"
