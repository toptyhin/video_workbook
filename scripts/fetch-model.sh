#!/usr/bin/env bash
# Скачивает модель faster-whisper (по умолчанию small) в resources/models.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
MODEL="${1:-small}"
OUT="$ROOT/resources/models/faster-whisper-$MODEL"
if [ -f "$OUT/model.bin" ]; then
  echo "Модель уже на месте: $OUT"
  exit 0
fi
export HF_HOME="${HF_HOME:-$ROOT/.cache/huggingface}"
mkdir -p "$HF_HOME"
"$ROOT/.venv/bin/pip" install -q huggingface_hub
"$ROOT/.venv/bin/python" - "$MODEL" "$OUT" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import snapshot_download

model, out = sys.argv[1], Path(sys.argv[2])
repo = f"Systran/faster-whisper-{model}"
path = snapshot_download(repo_id=repo, allow_patterns=["*.json", "*.txt", "*.bin", "*.model"])
out.mkdir(parents=True, exist_ok=True)
import shutil
for item in Path(path).iterdir():
    if item.is_file():
        shutil.copy2(item, out / item.name)
print("Модель сохранена в", out)
PY
