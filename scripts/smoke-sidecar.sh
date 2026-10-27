#!/usr/bin/env bash
# Smoke собранной раскладки: запускает sidecar ИЗ dist/linux-unpacked/resources
# ровно так, как его запустит Electron, и проверяет /api/health + отдачу SPA.
#
# Ловит класс ошибок «собралось, но не запускается»: неверный путь к sidecar,
# потерянные VL_RESOURCES_DIR/модели/ffmpeg, backend, падающий на старте.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
# Необязательный аргумент — каталог resources (например, распакованный AppImage).
RES="${1:-$ROOT/dist/linux-unpacked/resources}"
RES="$(cd "$RES" 2>/dev/null && pwd)" || { echo "Нет каталога resources: ${1:-}" >&2; exit 2; }
BIN="$RES/backend/vl-backend"
DATA="$ROOT/.tmp/smoke-packaged-data"
LOG="$ROOT/.tmp/smoke-packaged.log"

if [ ! -x "$BIN" ]; then
  echo "Нет исполняемого $BIN — сначала соберите артефакты (npm run dist:dir)" >&2
  exit 2
fi

rm -rf "$DATA"
mkdir -p "$DATA"
TOKEN="smoke-$(date +%s%N)"
VL_TOKEN="$TOKEN" \
VL_DATA_DIR="$DATA" \
VL_RESOURCES_DIR="$RES" \
VL_PORT=0 \
  "$BIN" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

PORT=""
for _ in $(seq 1 150); do
  PORT="$(grep -o 'VL_READY: *{"port": *[0-9]*' "$LOG" 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)"
  [ -n "$PORT" ] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "backend упал до VL_READY:" >&2
    tail -50 "$LOG" >&2
    exit 1
  fi
  sleep 0.2
done
if [ -z "$PORT" ]; then
  echo "backend не сообщил VL_READY за 30 с:" >&2
  tail -50 "$LOG" >&2
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
HEALTH="$(curl -fsS -H "X-VL-Token: $TOKEN" "$BASE/api/health")"
python3 - "$HEALTH" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
assert data.get("status") == "ok", f"health не ok: {data}"
print("health:", json.dumps(data, ensure_ascii=False))
PY

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
if [ "$code" != "200" ]; then
  echo "SPA не отдаётся (HTTP $code) — проверьте resources/frontend/dist" >&2
  exit 1
fi
if ! curl -fsS "$BASE/" | grep -q 'id="root"'; then
  echo "SPA index.html не содержит #root — фронтенд собран неверно" >&2
  exit 1
fi

echo "SMOKE OK: sidecar из resources запустился, health ok, SPA отдаётся (port $PORT)"
