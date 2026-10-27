#!/usr/bin/env bash
# Скачивает ONNX-модель эмбеддингов для семантического поиска (M12).
# Модель: intfloat/multilingual-e5-small (MIT), int8 ONNX-экспорт Xenova.
# Запуск: bash scripts/fetch-embed-model.sh
# Идемпотентно: уже скачанные файлы пропускаются. Сеть нужна только на этом шаге,
# рантайм приложения работает офлайн.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="${VL_EMBED_MODEL_DIR:-$ROOT/resources/models/multilingual-e5-small-onnx}"
REPO="${VL_EMBED_MODEL_REPO:-Xenova/multilingual-e5-small}"
BASE="https://huggingface.co/$REPO/resolve/main"
MIN_MODEL_BYTES="${VL_EMBED_MODEL_MIN_BYTES:-100000000}"

mkdir -p "$OUT/onnx"

fetch() {
  local rel="$1"
  local dst="$OUT/$rel"
  if [ -s "$dst" ]; then
    echo "уже есть: $rel"
    return 0
  fi
  echo "скачивание: $rel"
  local tmp="$dst.tmp"
  rm -f "$tmp"
  if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -o "$tmp" "$BASE/$rel"; then
    rm -f "$tmp"
    echo "не удалось скачать $BASE/$rel" >&2
    return 1
  fi
  mv "$tmp" "$dst"
}

fetch onnx/model_quantized.onnx
fetch tokenizer.json
fetch config.json
fetch tokenizer_config.json

MODEL_FILE="$OUT/onnx/model_quantized.onnx"
TOKENIZER_FILE="$OUT/tokenizer.json"
if [ ! -s "$MODEL_FILE" ] || [ ! -s "$TOKENIZER_FILE" ]; then
  echo "Модель неполная: нет $MODEL_FILE или $TOKENIZER_FILE" >&2
  exit 1
fi
SIZE=$(stat -c%s "$MODEL_FILE")
if [ "$SIZE" -lt "$MIN_MODEL_BYTES" ]; then
  echo "Файл модели подозрительно мал ($SIZE байт)" >&2
  exit 1
fi

echo "Модель эмбеддингов готова: $OUT ($(du -sh "$OUT" | cut -f1))"
echo "Семантический поиск включится автоматически при старте backend."
