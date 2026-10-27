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
# M12: семантический автоиндекс включён явно (после транскрипции + фоновая доиндексация).
# Модель лежит в $VL_RESOURCES_DIR/models/multilingual-e5-small-onnx.
export VL_EMBED_AUTOINDEX="${VL_EMBED_AUTOINDEX:-1}"
# M14: e2e гоняет саммари на fake-LLM (VL_SUMMARY_FAKE=1). Менеджер требует
# установленную gguf-модель, поэтому создаём sparse-заглушки в отдельном VL_MODELS_DIR
# (fake-клиент файл не читает, но резолвер проверяет размер из манифеста).
export VL_SUMMARY_FAKE="${VL_SUMMARY_FAKE:-1}"
export VL_MODELS_DIR="${VL_MODELS_DIR:-$ROOT/.tmp/e2e-models}"
if [ "$VL_SUMMARY_FAKE" = "1" ]; then
  mkdir -p "$VL_MODELS_DIR/lfm2.5-350m-thinking" "$VL_MODELS_DIR/qwen2.5-0.5b-instruct"
  [ -f "$VL_MODELS_DIR/lfm2.5-350m-thinking/model.gguf" ] || truncate -s 229314528 "$VL_MODELS_DIR/lfm2.5-350m-thinking/model.gguf"
  [ -f "$VL_MODELS_DIR/qwen2.5-0.5b-instruct/model.gguf" ] || truncate -s 491400032 "$VL_MODELS_DIR/qwen2.5-0.5b-instruct/model.gguf"
fi
rm -rf "$VL_DATA_DIR"; mkdir -p "$VL_DATA_DIR"
if [ ! -f "$VL_FRONTEND_DIR/index.html" ]; then
  echo "Нет frontend/dist — соберите: VITE_VL_TOKEN=$VL_TOKEN npm --prefix frontend run build" >&2
  exit 1
fi
FIX="$ROOT/.tmp/e2e-videos"
# Уроки лежат в подкаталоге library/: он сканируется как отслеживаемая папка.
# Фикстура записи (recording-fixture.webm) лежит уровнем выше и в библиотеку не попадает —
# базовые e2e ждут ровно 4 видео и не должны видеть лишнее.
LIB="$FIX/library"
rm -rf "$FIX"; mkdir -p "$LIB"
# webm/vp8+opus — играется в headless Chromium
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x203040:s=320x180:d=6" \
  -f lavfi -i "sine=frequency=330:duration=6" -shortest \
  -c:v libvpx -b:v 300k -c:a libopus "$LIB/lesson-01.webm"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x402030:s=320x180:d=4" \
  -f lavfi -i "sine=frequency=550:duration=4" -shortest \
  -c:v libvpx -b:v 300k -c:a libopus "$LIB/lesson-02.webm"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x304020:s=320x180:d=4" \
  -f lavfi -i "sine=frequency=220:duration=4" -shortest \
  -c:v mpeg4 -c:a aac -f matroska "$LIB/lesson-04-unsupported.mkv" || true
if command -v espeak-ng >/dev/null; then
  espeak-ng -v ru -s 140 -w "$ROOT/.tmp/e2e-speech.wav" \
    "Сегодня мы разберём производные сложных функций." || true
  if [ -s "$ROOT/.tmp/e2e-speech.wav" ]; then
    ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x304020:s=320x180:d=4" \
      -i "$ROOT/.tmp/e2e-speech.wav" -shortest -c:v libvpx -b:v 300k -c:a libopus \
      "$LIB/lesson-03.webm" || true
  fi
fi
# Фикстура для e2e записи экрана (mocked MediaRecorder в e2e/recording.spec.ts):
# ~2 с, 320x180, WebM VP9 + Opus (fallback VP8, если в ffmpeg нет libvpx-vp9).
# Читается тестом напрямую из файла; сканируется только каталог library/, поэтому
# в библиотеку фикстура не попадает.
RECORDING_FIXTURE="$FIX/recording-fixture.webm"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=0x102030:s=320x180:d=2:r=15" -f lavfi -i "sine=frequency=440:duration=2" \
    -shortest -c:v libvpx-vp9 -b:v 250k -c:a libopus -b:a 64k \
    "$RECORDING_FIXTURE" 2>/dev/null \
    || ffmpeg -y -hide_banner -loglevel error \
      -f lavfi -i "color=c=0x102030:s=320x180:d=2:r=15" -f lavfi -i "sine=frequency=440:duration=2" \
      -shortest -c:v libvpx -b:v 250k -c:a libopus -b:a 64k \
      "$RECORDING_FIXTURE" \
    || echo "e2e: не удалось создать recording-fixture.webm — тест записи будет пропущен" >&2
else
  echo "e2e: ffmpeg не найден — recording-fixture.webm не создан, тест записи будет пропущен" >&2
fi
(
  cd backend
  VL_TOKEN="$VL_TOKEN" VL_DATA_DIR="$VL_DATA_DIR" VL_FRONTEND_DIR="$VL_FRONTEND_DIR" \
  VL_RESOURCES_DIR="$VL_RESOURCES_DIR" VL_PORT="$VL_PORT" VL_CPU_THREADS=2 \
  VL_EMBED_AUTOINDEX="$VL_EMBED_AUTOINDEX" \
  VL_SUMMARY_FAKE="$VL_SUMMARY_FAKE" VL_MODELS_DIR="$VL_MODELS_DIR" \
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
# сидируем библиотеку через API: сканируем каталог уроков (без фикстуры записи)
EXPECTED=0
for video in "$LIB"/*; do
  [ -f "$video" ] && EXPECTED=$((EXPECTED + 1))
done
curl -sf -H "$H" -H "Content-Type: application/json" -d "{\"path\":\"$LIB\"}" \
  "$BASE/api/videos/scan" >/dev/null || true
for _ in $(seq 1 100); do
  TOTAL=$(curl -s -H "$H" "$BASE/api/videos" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo 0)
  [ "$TOTAL" -ge "$EXPECTED" ] && break
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
