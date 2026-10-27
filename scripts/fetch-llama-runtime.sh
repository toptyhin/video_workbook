#!/usr/bin/env bash
# M14: pinned CPU-сборка llama.cpp (llama-cli + libs) для resources/llama.
# Официальный Ubuntu x64 релиз ggml-org/llama.cpp, MIT. Сеть нужна только здесь.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${VL_LLAMA_VERSION:-b11669}"
SHA256="${VL_LLAMA_SHA256:-cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac}"
OUT="$ROOT/resources/llama"
TARBALL="$ROOT/.tmp/llama-download/llama-${VERSION}-bin-ubuntu-x64.tar.gz"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/llama-${VERSION}-bin-ubuntu-x64.tar.gz"

if [ -x "$OUT/llama-cli" ]; then
  echo "llama.cpp уже на месте: $("$OUT/llama-cli" --version 2>&1 | head -1)"
  exit 0
fi

mkdir -p "$OUT" "$(dirname "$TARBALL")"
if [ ! -s "$TARBALL" ]; then
  echo "Скачивание $URL"
  curl -fL --retry 3 -m 600 -H "User-Agent: VideoLessons-build" -o "$TARBALL" "$URL"
fi
echo "$SHA256  $TARBALL" | sha256sum -c -
rm -rf "$OUT"; mkdir -p "$OUT"
tar -xzf "$TARBALL" -C "$OUT" --strip-components=1
chmod +x "$OUT"/llama-* 2>/dev/null || true
"$OUT/llama-cli" --version | head -1
