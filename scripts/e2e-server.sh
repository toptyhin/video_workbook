#!/usr/bin/env bash
# Сервер для Playwright e2e: backend на фиксированном порту, отдаёт frontend/dist,
# сидирует временную библиотеку (видео + при возможности segments через tiny-модель).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export VL_TOKEN="${VL_TOKEN:-e2e-token}"
export VL_DATA_DIR="${VL_DATA_DIR:-$ROOT/.tmp/e2e-data}"
export VL_FRONTEND_DIR="$ROOT/frontend/dist"
export VL_PORT="${VL_PORT:-8899}"
export VL_RESOURCES_DIR="${VL_RESOURCES_DIR:-$ROOT/resources}"
rm -rf "$VL_DATA_DIR"; mkdir -p "$VL_DATA_DIR"
if [ ! -f "$VL_FRONTEND_DIR/index.html" ]; then
  echo "Нет frontend/dist — соберите: VITE_VL_TOKEN=$VL_TOKEN npm --prefix frontend run build" >&2
  exit 1
fi
FIX="$ROOT/.tmp/e2e-videos"; rm -rf "$FIX"; mkdir -p "$FIX"
# webm/vp8+opus — играется в headless Chromium
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x203040:s=320x180:d=6" \
  -f lavfi -i "sine=frequency=330:duration=6" -shortest \
  -c:v libvpx -b:v 300k -c:a libopus "$FIX/lesson-01.webm"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x402030:s=320x180:d=4" \
  -f lavfi -i "sine=frequency=550:duration=4" -shortest \
  -c:v libvpx -b:v 300k -c:a libopus "$FIX/lesson-02.webm"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x304020:s=320x180:d=4" \
  -f lavfi -i "sine=frequency=220:duration=4" -shortest \
  -c:v mpeg4 -c:a aac -f matroska "$FIX/lesson-04-unsupported.mkv" || true
if command -v espeak-ng >/dev/null; then
  espeak-ng -v ru -s 140 -w "$ROOT/.tmp/e2e-speech.wav" \
    "Сегодня мы разберём производные сложных функций." || true
  if [ -s "$ROOT/.tmp/e2e-speech.wav" ]; then
    ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x304020:s=320x180:d=4" \
      -i "$ROOT/.tmp/e2e-speech.wav" -shortest -c:v libvpx -b:v 300k -c:a libopus \
      "$FIX/lesson-03.webm" || true
  fi
fi
(
  cd backend
  VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" VL_FRONTEND_DIR="$VL_FRONTEND_DIR" \
  VL_RESOURCES_DIR="$VL_RESOURCES_DIR" VL_PORT="$VL_PORT" VL_CPU_THREADS=2 \
    "$ROOT/.venv/bin/python" -m app.main > "$ROOT/.tmp/e2e-server.log" 2>&1
) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM
H="X-VL-Token: $VL_TOKEN"
BASE="http://127.0.0.1:$VL_PORT"
for _ in $(seq 1 100); do
  if curl -sf -H "$H" "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
# сидируем библиотеку через API
curl -sf -H "$H" -H "Content-Type: application/json" -d "{\"path\":\"$FIX\"}" "$BASE/api/videos/scan" >/dev/null || true
for _ in $(seq 1 100); do
  TOTAL=$(curl -s -H "$H" "$BASE/api/videos" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo 0)
  [ "$TOTAL" -ge 2 ] && break
  sleep 0.2
done
# опциональная реальная транскрипция (если есть tiny-модель): нужно для тестов таймингов
MODEL="$ROOT/resources/models/faster-whisper-tiny"
if [ -f "$MODEL/model.bin" ] && [ "${VL_E2E_TRANSCRIBE:-1}" = "1" ]; then
  curl -sf -X PATCH -H "$H" -H "Content-Type: application/json" -d '{"whisper_model":"tiny","language":"ru"}' "$BASE/api/settings" >/dev/null || true
  IDS=$(curl -s -H "$H" "$BASE/api/videos" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([i["id"] for i in d["items"]]))' 2>/dev/null || echo '[]')
  if [ "$IDS" != "[]" ]; then
    curl -sf -H "$H" -H "Content-Type: application/json" -d "{\"ids\":$IDS}" "$BASE/api/videos/enqueue" >/dev/null || true
  fi
fi
echo "e2e server ready on $BASE"
wait $SERVER_PID
