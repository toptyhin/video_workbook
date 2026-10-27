#!/usr/bin/env bash
# Dev-режим: uvicorn (8765) + Vite (5173) + Electron (опционально).
# VL_NO_ELECTRON=1 — только backend + Vite (например, для браузера/CI).
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
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Нет frontend/node_modules: npm --prefix frontend install" >&2
  exit 1
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

wait_for() {
  local name="$1" url="$2" headers="${3:-}" seconds="${4:-60}"
  for _ in $(seq 1 "$seconds"); do
    if [ -n "$headers" ]; then
      curl -sf -H "$headers" "$url" >/dev/null 2>&1 && return 0
    else
      curl -sf "$url" >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  echo "Не дождались $name ($url) за ${seconds}s" >&2
  return 1
}

echo "== backend → :8765 =="
( cd backend && VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" VL_PORT=8765 \
    "$ROOT/.venv/bin/python" -m app.main > "$ROOT/.tmp/dev-backend.log" 2>&1 ) &
PIDS+=("$!")

echo "== vite → :5173 =="
( cd "$ROOT" && VITE_VL_TOKEN="$VL_TOKEN" VL_DEV_BACKEND_URL="$VL_DEV_BACKEND_URL" \
    npm --prefix frontend run dev > "$ROOT/.tmp/dev-vite.log" 2>&1 ) &
PIDS+=("$!")

if ! wait_for "backend" "http://127.0.0.1:8765/api/health" "X-VL-Token: $VL_TOKEN" 60; then
  echo "--- backend log ---"; tail -20 "$ROOT/.tmp/dev-backend.log" || true
  exit 1
fi
if ! wait_for "vite" "http://127.0.0.1:5173/" "" 90; then
  echo "--- vite log ---"; tail -30 "$ROOT/.tmp/dev-vite.log" || true
  exit 1
fi
echo "== готово: backend + vite =="
echo "   token: $VL_TOKEN"
echo "   UI:    http://127.0.0.1:5173/  (в браузере токен уже вписан в сборку dev-сервера)"

if [ "${VL_NO_ELECTRON:-0}" = "1" ]; then
  wait
fi

if [ ! -x "$ROOT/node_modules/electron/dist/electron" ]; then
  echo "$ROOT/node_modules/electron/dist/electron"
  echo "Electron не установлен (node_modules/electron/dist/electron) — открывайте UI в браузере." >&2
  wait
fi

echo "== electron =="
VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" VL_DEV_URL="$VL_DEV_URL" \
  VL_BACKEND_URL="$VL_DEV_BACKEND_URL" "$ROOT/node_modules/electron/dist/electron" "$ROOT" &
PIDS+=("$!")
wait
