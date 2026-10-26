#!/usr/bin/env bash
# Dev-режим: uvicorn (8765) + Vite (5173) + Electron (опционально).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export VL_TOKEN="${VL_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
export VL_DATA_DIR="${VL_DATA_DIR:-$ROOT/.tmp/dev-data}"
export VL_DEV_BACKEND_URL="${VL_DEV_BACKEND_URL:-http://127.0.0.1:8765}"
export VL_DEV_URL="${VL_DEV_URL:-http://127.0.0.1:5173}"
mkdir -p "$VL_DATA_DIR"

if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "Нет .venv: python3.11 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt" >&2
  exit 1
fi

cleanup() {
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" "${ELECTRON_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

( cd backend && VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" vl_port=8765 \
    VL_PORT=8765 "$ROOT/.venv/bin/python" -m app.main ) &
BACKEND_PID=$!

npm --prefix frontend run dev &
FRONTEND_PID=$!

sleep 2
if [ "${VL_NO_ELECTRON:-0}" != "1" ] && [ -x "$ROOT/node_modules/electron/dist/electron" ]; then
  VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" VL_DEV_URL="$VL_DEV_URL" \
    VL_BACKEND_URL="$VL_DEV_BACKEND_URL" "$ROOT/node_modules/electron/dist/electron" "$ROOT" &
  ELECTRON_PID=$!
fi
wait
